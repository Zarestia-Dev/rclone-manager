use log::{debug, error, info};
use serde_json::json;
use tauri::{Emitter, State};

use crate::utils::types::{AppSettings, SettingsState};

/// **Core settings operations - Load, Save, Update, Reset**
///
/// This module handles the basic CRUD operations for application settings.
/// It provides a clean interface for loading, saving, and updating settings
/// while maintaining backward compatibility with existing APIs.
/// **Load settings from store with improved error handling and lazy initialization**
#[tauri::command]
pub async fn load_settings<'a>(
    state: State<'a, SettingsState<tauri::Wry>>,
) -> Result<serde_json::Value, String> {
    let store_arc = &state.store;
    let store_guard = store_arc.lock().await;

    // Try to reload from disk, but handle missing file gracefully without creating it
    let stored_settings = match store_guard.reload() {
        Ok(_) => {
            // Successfully loaded from disk - get stored settings
            store_guard
                .get("app_settings")
                .unwrap_or_else(|| json!({}))
                .clone()
        }
        Err(e) => {
            match &e {
                tauri_plugin_store::Error::Io(io_err)
                    if io_err.kind() == std::io::ErrorKind::NotFound =>
                {
                    // File doesn't exist - use empty object (defaults will be merged below)
                    println!("📁 Settings file not found. Using defaults (lazy initialization).");
                    json!({})
                }
                _ => {
                    println!("❌ Failed to reload settings store: {e}");
                    return Err(format!("Failed to reload settings store: {e}"));
                }
            }
        }
    };

    // **Load default settings and metadata**
    let default_settings = AppSettings::default();
    let metadata = AppSettings::get_metadata();

    // **Merge stored values with defaults (stored values override defaults)**
    let mut merged_settings = serde_json::to_value(default_settings).unwrap();

    // Only merge if we have stored settings
    if !stored_settings.is_null()
        && stored_settings
            .as_object()
            .is_some_and(|obj| !obj.is_empty())
    {
        if let Some(merged_obj) = merged_settings.as_object_mut() {
            for (category, values) in merged_obj.iter_mut() {
                if let Some(stored_category) = stored_settings.get(category) {
                    if let Some(values_obj) = values.as_object_mut() {
                        for (key, default_value) in values_obj.iter_mut() {
                            if let Some(stored_value) = stored_category.get(key) {
                                *default_value = stored_value.clone();
                            }
                            // If not found in stored settings, keep the default value
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

    println!("✅ Settings loaded successfully (lazy initialization).");
    Ok(response)
}

/// **Load a specific setting value with improved performance**
#[tauri::command]
pub async fn load_setting_value<'a>(
    category: String,
    key: String,
    state: State<'a, SettingsState<tauri::Wry>>,
) -> Result<serde_json::Value, String> {
    let store_arc = &state.store;
    let store_guard = store_arc.lock().await;

    // Reload from disk and handle missing file gracefully
    let stored_settings = match store_guard.reload() {
        Ok(_) => store_guard
            .get("app_settings")
            .unwrap_or_else(|| json!({}))
            .clone(),
        Err(e) => {
            match &e {
                tauri_plugin_store::Error::Io(io_err)
                    if io_err.kind() == std::io::ErrorKind::NotFound =>
                {
                    // File doesn't exist, return from defaults
                    debug!("📁 Settings file not found, using defaults for {category}.{key}");
                    json!({})
                }
                _ => {
                    return Err(format!("Failed to reload settings store: {e}"));
                }
            }
        }
    };

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

/// **Save settings with improved efficiency - only saves changed values and lazy writes**
#[tauri::command]
pub async fn save_settings(
    state: State<'_, SettingsState<tauri::Wry>>,
    updated_settings: serde_json::Value,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    debug!(
        "🔄 save_settings called with: {}",
        serde_json::to_string(&updated_settings)
            .unwrap_or_else(|_| "failed to serialize".to_string())
    );

    let (stored_settings, has_meaningful_changes, changed_settings) = {
        let store = state.store.lock().await;

        // Load current stored settings (not defaults)
        let mut stored_settings = store.get("app_settings").unwrap_or_else(|| json!({}));

        // Load defaults for comparison
        let default_settings = serde_json::to_value(AppSettings::default()).unwrap();

        // Prepare a new object to store only changed values and track what actually changed
        let mut changed_settings = serde_json::Map::new();
        let mut has_meaningful_changes = false;

        // Merge updates dynamically and track changes
        if let Some(settings_obj) = updated_settings.as_object() {
            for (category, new_values) in settings_obj.iter() {
                if let Some(new_values_obj) = new_values.as_object() {
                    let mut category_changes = serde_json::Map::new();

                    // Ensure category exists in stored settings
                    if !stored_settings.as_object().unwrap().contains_key(category) {
                        stored_settings.as_object_mut().unwrap().insert(
                            category.clone(),
                            serde_json::Value::Object(serde_json::Map::new()),
                        );
                    }

                    let stored_category = stored_settings.get_mut(category).unwrap();
                    let stored_obj = stored_category.as_object_mut().unwrap();

                    for (key, new_value) in new_values_obj.iter() {
                        // Get the default value for this setting
                        let default_value =
                            default_settings.get(category).and_then(|cat| cat.get(key));

                        // Get the currently stored value
                        let current_stored_value = stored_obj.get(key);

                        // Determine if we need to make a change
                        let should_store = Some(new_value) != default_value;
                        let value_changed = current_stored_value != Some(new_value);

                        if should_store {
                            // Value is different from default, store it
                            if value_changed {
                                stored_obj.insert(key.clone(), new_value.clone());
                                category_changes.insert(key.clone(), new_value.clone());
                                has_meaningful_changes = true;
                            }
                        } else {
                            // Value is same as default, remove it from stored settings if it exists
                            if stored_obj.remove(key).is_some() {
                                // We removed a stored value, so emit the default value as the change
                                if let Some(default_val) = default_value {
                                    category_changes.insert(key.clone(), default_val.clone());
                                }
                                has_meaningful_changes = true;
                            }
                        }
                    }

                    // Only add category if there are changes
                    if !category_changes.is_empty() {
                        changed_settings.insert(
                            category.clone(),
                            serde_json::Value::Object(category_changes),
                        );
                    }
                }
            }
        }

        // Clean up empty categories
        if let Some(stored_obj) = stored_settings.as_object_mut() {
            stored_obj.retain(|_, v| {
                if let Some(category_obj) = v.as_object() {
                    !category_obj.is_empty()
                } else {
                    true
                }
            });
        }

        (stored_settings, has_meaningful_changes, changed_settings)
    };

    // Only save if there are meaningful changes
    if has_meaningful_changes {
        let store = state.store.lock().await;
        store.set("app_settings".to_string(), stored_settings);
        store.save().map_err(|e| {
            error!("❌ Failed to save settings: {e}");
            e.to_string()
        })?;
        drop(store); // Explicitly drop the lock

        debug!(
            "🟢 Emitting system_settings_changed with payload: {}",
            serde_json::to_string(&changed_settings)
                .unwrap_or_else(|_| "failed to serialize".to_string())
        );

        // ✅ Emit only changed settings
        app_handle
            .emit("system_settings_changed", changed_settings.clone())
            .map_err(|e| {
                error!("❌ Failed to emit system_settings_changed event: {e}");
                e.to_string()
            })?;

        info!(
            "✅ Settings saved successfully with {} changes.",
            changed_settings.len()
        );
    } else {
        debug!("⚠️ No meaningful changes detected, skipping save.");
    }

    Ok(())
}

/// **Reset settings to default values**
#[tauri::command]
pub async fn reset_settings(
    state: State<'_, SettingsState<tauri::Wry>>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let default_settings = AppSettings::default();
    let default_settings_value = serde_json::to_value(default_settings)
        .map_err(|e| format!("Failed to serialize default settings: {e}"))?;
    save_settings(state, default_settings_value, app_handle.clone()).await?;

    app_handle.emit("remote_presence_changed", json!({})).ok();
    app_handle.emit("system_settings_changed", json!({})).ok();
    Ok(())
}

/// **Reset a single setting to its default value**
#[tauri::command]
pub async fn reset_setting(
    category: String,
    key: String,
    state: State<'_, SettingsState<tauri::Wry>>,
    app_handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let store = state.store.lock().await;

    // Load current stored settings
    let mut stored_settings = store.get("app_settings").unwrap_or_else(|| json!({}));

    // Get the default value
    let default_value = get_effective_setting_value(&category, &key, &json!({}));

    // Remove the setting from stored settings (so it falls back to default)
    if let Some(stored_category) = stored_settings.get_mut(&category) {
        if let Some(stored_obj) = stored_category.as_object_mut() {
            stored_obj.remove(&key);

            // Remove empty categories
            if stored_obj.is_empty() {
                stored_settings.as_object_mut().unwrap().remove(&category);
            }
        }
    }

    // Save the updated settings
    store.set("app_settings".to_string(), stored_settings);
    store.save().map_err(|e| {
        error!("❌ Failed to save settings: {e}");
        e.to_string()
    })?;

    // Emit the change - create the JSON structure properly
    let mut change_category = serde_json::Map::new();
    change_category.insert(key.clone(), default_value.clone());

    let mut change_payload = serde_json::Map::new();
    change_payload.insert(category.clone(), serde_json::Value::Object(change_category));

    app_handle
        .emit(
            "system_settings_changed",
            serde_json::Value::Object(change_payload),
        )
        .unwrap();

    info!("✅ Setting {category}.{key} reset to default");
    Ok(default_value)
}

/// **Get the effective value for a setting (stored value or default)**
fn get_effective_setting_value(
    category: &str,
    key: &str,
    stored_settings: &serde_json::Value,
) -> serde_json::Value {
    // Try to get from stored settings first
    if let Some(stored_value) = stored_settings.get(category).and_then(|cat| cat.get(key)) {
        return stored_value.clone();
    }

    // Fall back to default
    let default_settings = serde_json::to_value(AppSettings::default()).unwrap();
    default_settings
        .get(category)
        .and_then(|cat| cat.get(key))
        .cloned()
        .unwrap_or(serde_json::Value::Null)
}
