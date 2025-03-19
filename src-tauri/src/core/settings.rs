use std::sync::{Arc, Mutex};
use serde_json::json;
use tauri::Runtime;
use tauri_plugin_store::Store;
use tauri::State;

use super::settings_store::AppSettings;

/// Global settings store
pub struct SettingsState<R: Runtime> {
    pub store: Arc<Mutex<Arc<Store<R>>>>,
}


#[tauri::command]
pub async fn save_settings<'a>(
    state: State<'a, SettingsState<tauri::Wry>>, // ✅ Specify Wry as the Runtime
    settings: AppSettings,
) -> Result<(), String> {
    let store = state.store.lock().unwrap();
    
    store.set("app_settings".to_string(), json!(settings));

    // ✅ Save the store to disk
    store.save().map_err(|e| e.to_string())?;

    Ok(())
}

/// ✅ Load settings from Tauri state
#[tauri::command]
pub async fn load_settings<'a>(state: State<'a, SettingsState<tauri::Wry>>) -> Result<AppSettings, String> {
    let store = state.store.lock().unwrap();

    // ✅ Reload store from disk (ensures latest data)
    store.reload().map_err(|e: tauri_plugin_store::Error| e.to_string())?;

    // ✅ Fetch existing settings or return default
    if let Some(settings) = store.get("app_settings") {
        let settings: AppSettings = serde_json::from_value(settings.clone()).map_err(|e| e.to_string())?;
        println!("Loaded settings from load_settings: {:?}", settings);
        Ok(settings)
    } else {
        Ok(AppSettings::default()) // ✅ Return default if none found
    }
}