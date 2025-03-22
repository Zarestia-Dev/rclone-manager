use serde_json::{json, Value};
use std::{
    fs::{self, create_dir_all, File}, 
    io::Write, 
    path::PathBuf, 
    sync::{Arc, Mutex}
};
use tauri::{Runtime, State};
use tauri_plugin_store::Store;

use super::settings_store::AppSettings;

/// Global settings store
pub struct SettingsState<R: Runtime> {
    pub store: Arc<Mutex<Arc<Store<R>>>>,
    pub config_dir: PathBuf,
}

/// ✅ Load settings from store
#[tauri::command]
pub async fn load_settings<'a>(
    state: State<'a, SettingsState<tauri::Wry>>,
) -> Result<serde_json::Value, String> {
    let store = state.store.lock().unwrap();

    // ✅ Load stored settings
    let stored_settings = store.get("app_settings").unwrap_or_else(|| json!({})).clone();

    // ✅ Load default settings
    let default_settings = AppSettings::default();
    let metadata = AppSettings::get_metadata();

    // ✅ Merge stored values into the structure while preserving metadata
    let mut merged_settings = serde_json::to_value(default_settings).unwrap();
    merged_settings
        .as_object_mut()
        .unwrap()
        .iter_mut()
        .for_each(|(category, values)| {
            if let Some(stored_category) = stored_settings.get(category) {
                values
                    .as_object_mut()
                    .unwrap()
                    .iter_mut()
                    .for_each(|(key, value)| {
                        if let Some(stored_value) = stored_category.get(key) {
                            *value = stored_value.clone();
                        }
                    });
            }
        });

    // ✅ Attach metadata
    let response = json!({
        "settings": merged_settings,
        "metadata": metadata
    });

    Ok(response)
}



/// ✅ Save only modified settings
#[tauri::command]
pub async fn save_settings(
    state: State<'_, SettingsState<tauri::Wry>>, 
    updated_settings: serde_json::Value
) -> Result<(), String> {
    let store = state.store.lock().unwrap();

    // ✅ Load stored settings
    let mut stored_settings = store.get("app_settings").unwrap_or_else(|| json!({}));

    // ✅ Merge only updated values
    if let Some(settings_obj) = updated_settings.as_object() {
        for (category, new_values) in settings_obj.iter() {
            if let Some(stored_category) = stored_settings.get_mut(category) {
                if let Some(stored_obj) = stored_category.as_object_mut() {
                    for (key, value) in new_values.as_object().unwrap() {
                        stored_obj.insert(key.clone(), value.clone());
                    }
                }
            } else {
                stored_settings.as_object_mut().unwrap().insert(category.clone(), new_values.clone());
            }
        }
    }

    // ✅ Save only the values
    store.set("app_settings".to_string(), stored_settings);
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}



#[tauri::command]
pub async fn save_remote_settings(
    remote_name: String,
    settings: Value, // ✅ Accepts dynamic JSON
    state: State<'_, SettingsState<tauri::Wry>>,
) -> Result<(), String> {
    // Ensure config_dir is a directory
    if state.config_dir.exists() && !state.config_dir.is_dir() {
        fs::remove_file(&state.config_dir).map_err(|e| format!(
            "Failed to remove file at {:?}: {}", 
            state.config_dir, e
        ))?;
    }
    create_dir_all(&state.config_dir)
        .map_err(|e| format!("Failed to create config directory: {}", e))?;

    let remote_config_dir = state.config_dir.join("remotes"); // ✅ Ensure this is a directory
    let remote_config_path = remote_config_dir.join(format!("{}.json", remote_name));

    // ✅ Ensure "remotes" is a directory
    if remote_config_dir.exists() && !remote_config_dir.is_dir() {
        fs::remove_file(&remote_config_dir).map_err(|e| format!(
            "Failed to remove file at {:?}: {}", 
            remote_config_dir, e
        ))?;
    }

    // ✅ Create the directory if it doesn't exist
    create_dir_all(&remote_config_dir)
        .map_err(|e| format!("Failed to create settings directory: {}", e))?;

    // ✅ Save the settings as JSON
    let mut file = File::create(&remote_config_path)
        .map_err(|e| format!("Failed to create remote settings file: {}", e))?;
    
    file.write_all(settings.to_string().as_bytes())
        .map_err(|e| format!("Failed to save remote settings: {}", e))?;

    println!("✅ Remote settings saved at {:?}", remote_config_path);
    Ok(())
}

#[tauri::command]
pub async fn delete_remote_settings(
    remote_name: String,
    state: State<'_, SettingsState<tauri::Wry>>,
) -> Result<(), String> {
    let remote_config_dir = state.config_dir.join("remotes");
    let remote_config_path = remote_config_dir.join(format!("{}.json", remote_name));

    // ✅ Check if the file exists
    if !remote_config_path.exists() {
        return Err(format!("Remote settings for '{}' not found.", remote_name));
    }

    // ✅ Delete the file
    fs::remove_file(&remote_config_path)
        .map_err(|e| format!("Failed to delete remote settings: {}", e))?;

    println!("✅ Remote settings for '{}' deleted.", remote_name);
    Ok(())
}

#[tauri::command]
pub async fn get_remote_settings(
    remote_name: String,
    state: State<'_, SettingsState<tauri::Wry>>,
) -> Result<serde_json::Value, String> {
    let remote_config_dir = state.config_dir.join("remotes");
    let remote_config_path = remote_config_dir.join(format!("{}.json", remote_name));

    // ✅ Check if the file exists
    if !remote_config_path.exists() {
        return Err(format!("Remote settings for '{}' not found.", remote_name));
    }

    // ✅ Read the JSON file
    let file_content = fs::read_to_string(&remote_config_path)
        .map_err(|e| format!("Failed to read remote settings: {}", e))?;

    // ✅ Parse JSON
    let settings: serde_json::Value = serde_json::from_str(&file_content)
        .map_err(|e| format!("Failed to parse remote settings: {}", e))?;

    println!("✅ Loaded settings for remote '{}': {:?}", remote_name, settings);
    Ok(settings)
}



// #[tauri::command]
// pub async fn export_settings<R: Runtime>(state: State<'_, SettingsState<R>>) -> Result<PathBuf, String> {
//     let export_path = state.config_dir.join("rclone_settings_backup.zip");
//     let settings_json = state.config_dir.join("settings.json");
//     let remotes_dir = state.config_dir.join("remotes");

//     let file = File::create(&export_path).map_err(|e| format!("Failed to create backup file: {}", e))?;
//     let mut zip = zip::ZipWriter::new(file);

//     // Add settings.json
//     let settings_content = fs::read_to_string(&settings_json).map_err(|e| format!("Failed to read settings.json: {}", e))?;
//     zip.start_file("settings.json", Default::default()).unwrap();
//     zip.write_all(settings_content.as_bytes()).unwrap();

//     // Add remote configs
//     for entry in fs::read_dir(&remotes_dir).map_err(|e| format!("Failed to read remotes dir: {}", e))? {
//         let entry = entry.map_err(|e| format!("Failed to read remote file: {}", e))?;
//         let file_name = entry.file_name().to_string_lossy().to_string();
//         let file_content = fs::read_to_string(entry.path()).map_err(|e| format!("Failed to read {}: {}", file_name, e))?;

//         zip.start_file(format!("remotes/{}", file_name), Default::default()).unwrap();
//         zip.write_all(file_content.as_bytes()).unwrap();
//     }

//     zip.finish().map_err(|e| format!("Failed to finish zip archive: {}", e))?;

//     Ok(export_path)
// }


// #[tauri::command]
// pub async fn import_settings<R: Runtime>(
//     archive_path: PathBuf,
//     state: State<'_, SettingsState<R>>,
// ) -> Result<(), String> {
//     let mut zip = zip::ZipArchive::new(File::open(&archive_path).map_err(|e| format!("Failed to open zip file: {}", e))?)
//         .map_err(|e| format!("Failed to read zip archive: {}", e))?;

//     for i in 0..zip.len() {
//         let mut file = zip.by_index(i).map_err(|e| format!("Failed to access file in zip: {}", e))?;
//         let outpath = state.config_dir.join(file.name());

//         if file.is_dir() {
//             fs::create_dir_all(&outpath).map_err(|e| format!("Failed to create directory: {}", e))?;
//         } else {
//             let mut outfile = File::create(&outpath).map_err(|e| format!("Failed to create file: {}", e))?;
//             io::copy(&mut file, &mut outfile).map_err(|e| format!("Failed to write file: {}", e))?;
//         }
//     }

//     Ok(())
// }
