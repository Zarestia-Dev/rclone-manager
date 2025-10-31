use log::{debug, info};
use serde_json::json;
use tauri::{Emitter, State};

use crate::utils::types::settings::{AppSettings, SettingMetadata, SettingsState};

pub fn load_startup_settings(
    state: &State<SettingsState<tauri::Wry>>,
) -> Result<AppSettings, String> {
    let store = state.store.blocking_lock();
    let stored_val = store
        .get("app_settings")
        .clone()
        .unwrap_or(serde_json::json!({}));
    let default_settings = AppSettings::default();

    // Merge stored settings on top of defaults.
    let mut merged = serde_json::to_value(default_settings).unwrap();
    if let (Some(merged_obj), Some(stored_obj)) = (merged.as_object_mut(), stored_val.as_object()) {
        for (category, values) in stored_obj {
            if let Some(merged_cat) = merged_obj.get_mut(category)
                && let (Some(merged_cat_obj), Some(values_obj)) =
                    (merged_cat.as_object_mut(), values.as_object())
            {
                for (key, val) in values_obj {
                    merged_cat_obj.insert(key.clone(), val.clone());
                }
            }
        }
    }

    serde_json::from_value(merged).map_err(|e| format!("Failed to parse merged settings: {}", e))
}

#[tauri::command]
pub async fn load_settings<'a>(
    state: State<'a, SettingsState<tauri::Wry>>,
) -> Result<serde_json::Value, String> {
    let store_arc = &state.store;
    let store_guard = store_arc.lock().await;

    // Load stored settings, defaulting to an empty JSON object if the file doesn't exist.
    let stored_settings = match store_guard.reload() {
        Ok(_) => store_guard.get("app_settings").clone().unwrap_or(json!({})),
        Err(_) => {
            info!("📁 Settings file not found. Using defaults.");
            json!({})
        }
    };

    // Get the complete metadata map from our settings_store. This is our blueprint.
    let mut metadata: std::collections::HashMap<String, SettingMetadata> =
        AppSettings::get_metadata();

    // This is the core simplification: Iterate through our blueprint and inject the real values.
    for (key, option) in metadata.iter_mut() {
        let parts: Vec<&str> = key.split('.').collect();
        if parts.len() == 2 {
            let category = parts[0];
            let setting_name = parts[1];

            // Get the effective value (stored value, falling back to the default value within the option).
            let effective_value = stored_settings
                .get(category)
                .and_then(|cat| cat.get(setting_name))
                .cloned()
                .unwrap_or_else(|| option.default.clone());

            // Inject the effective value directly into the SettingMetadata.
            option.value = Some(effective_value.clone());
        }
    }

    // The entire response is now just the map of fully-formed SettingMetadata objects.
    // The frontend receives everything it needs in one clean package.
    let response = json!({
        "options": metadata
    });

    info!("✅ Settings loaded and merged successfully.");
    Ok(response)
}

#[tauri::command]
pub async fn save_setting(
    category: String,
    key: String,
    value: serde_json::Value,
    state: State<'_, SettingsState<tauri::Wry>>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let store = state.store.lock().await;
    let mut stored_settings = store.get("app_settings").clone().unwrap_or(json!({}));

    let default_value = AppSettings::get_metadata()
        .get(&format!("{}.{}", category, key))
        .map(|meta| meta.default.clone()) // Directly access the default
        .unwrap_or(serde_json::Value::Null);

    // The rest of the logic is now perfect
    if stored_settings.get(&category).is_none() {
        stored_settings
            .as_object_mut()
            .unwrap()
            .insert(category.clone(), json!({}));
    }
    let stored_category = stored_settings
        .get_mut(&category)
        .unwrap()
        .as_object_mut()
        .unwrap();

    if value == default_value {
        stored_category.remove(&key);
        debug!(
            "🔄 Setting {}.{} set to default. Removing from store.",
            category, key
        );
    } else {
        stored_category.insert(key.clone(), value.clone());
        debug!(
            "📝 Saving setting {}.{} with value: {}",
            category, key, value
        );
    }

    if stored_category.is_empty() {
        stored_settings.as_object_mut().unwrap().remove(&category);
    }

    store.set("app_settings".to_string(), stored_settings);
    store.save().map_err(|e| e.to_string())?;

    let change_payload = json!({ category.clone(): { key.clone(): value } });
    app_handle
        .emit("system_settings_changed", change_payload)
        .unwrap();

    info!("✅ Setting {}.{} saved successfully.", category, key);
    Ok(())
}

#[tauri::command]
pub async fn reset_setting(
    category: String,
    key: String,
    state: State<'_, SettingsState<tauri::Wry>>,
    app_handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let default_value = AppSettings::get_metadata()
        .get(&format!("{}.{}", category, key))
        .map(|meta| meta.default.clone())
        .unwrap_or(serde_json::Value::Null);

    save_setting(
        category.clone(),
        key.clone(),
        default_value.clone(),
        state,
        app_handle,
    )
    .await?;

    info!("✅ Setting {}.{} reset to default.", category, key);
    Ok(default_value)
}

#[tauri::command]
pub async fn reset_settings(
    state: State<'_, SettingsState<tauri::Wry>>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let store = state.store.lock().await;

    store.set("app_settings".to_string(), json!({}));
    store.save().map_err(|e| e.to_string())?;

    let default_settings = AppSettings::default();
    app_handle
        .emit("system_settings_changed", &default_settings)
        .unwrap();
    info!("✅ All settings have been reset to default.");
    Ok(())
}
