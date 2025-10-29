use log::{debug, info};
use serde_json::json;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_store::StoreBuilder;
use tokio::sync::Mutex;

use crate::utils::types::all_types::SettingsState;

/// **RClone Backend Settings Manager**
///
/// Manages RClone backend options in a separate file (backend.json)
/// This keeps RClone-specific runtime configurations separate from app settings
pub struct RCloneBackendStore {
    store: Mutex<std::sync::Arc<tauri_plugin_store::Store<tauri::Wry>>>,
}

impl RCloneBackendStore {
    /// Initialize RClone backend store with proper path
    /// Uses the same config directory as the main settings store for consistency
    pub fn new(app_handle: &AppHandle, config_dir: &std::path::Path) -> Result<Self, String> {
        let store_path = config_dir.join("backend.json");
        info!("📦 Initializing RClone backend store at: {:?}", store_path);
        let store = StoreBuilder::new(app_handle, store_path.clone())
            .build()
            .map_err(|e| format!("Failed to create RClone backend store: {}", e))?;

        Ok(Self {
            store: Mutex::new(store),
        })
    }
}

/// **Load RClone backend options from separate store**
#[tauri::command]
pub async fn load_rclone_backend_options(
    app_handle: AppHandle,
) -> Result<serde_json::Value, String> {
    debug!("Loading RClone backend options");

    // Get or create the backend store
    let backend_store = app_handle
        .try_state::<RCloneBackendStore>()
        .ok_or("RClone backend store not initialized")?;

    let store_guard = backend_store.store.lock().await;

    // Try to reload from disk, handle missing file gracefully
    let stored_options = match store_guard.reload() {
        Ok(_) => store_guard
            .get("backend")
            .unwrap_or_else(|| json!({}))
            .clone(),
        Err(e) => match &e {
            tauri_plugin_store::Error::Io(io_err)
                if io_err.kind() == std::io::ErrorKind::NotFound =>
            {
                debug!("📁 RClone options file not found. Using empty object.");
                json!({})
            }
            _ => {
                return Err(format!("Failed to reload RClone options store: {}", e));
            }
        },
    };

    info!("✅ RClone backend options loaded successfully");
    Ok(stored_options)
}

/// **Save RClone backend options to separate store**
#[tauri::command]
pub async fn save_rclone_backend_options(
    app_handle: AppHandle,
    options: serde_json::Value,
) -> Result<(), String> {
    debug!("Saving RClone backend options");

    let backend_store = app_handle
        .try_state::<RCloneBackendStore>()
        .ok_or("RClone backend store not initialized")?;

    let store_guard = backend_store.store.lock().await;

    // Save to store
    store_guard.set("backend", options.clone());

    // Persist to disk
    store_guard
        .save()
        .map_err(|e| format!("Failed to save RClone options: {}", e))?;

    info!("✅ RClone backend options saved successfully");
    Ok(())
}

/// **Save a single RClone backend option (for immediate updates)**
#[tauri::command]
pub async fn save_rclone_backend_option(
    app_handle: AppHandle,
    block: String,
    option: String,
    value: serde_json::Value,
) -> Result<(), String> {
    debug!("Saving RClone option: {}.{}", block, option);

    let backend_store = app_handle
        .try_state::<RCloneBackendStore>()
        .ok_or("RClone backend store not initialized")?;

    let store_guard = backend_store.store.lock().await;

    // Load existing options
    let _ = store_guard.reload();
    let mut options = store_guard
        .get("backend")
        .unwrap_or_else(|| json!({}))
        .clone();

    // Ensure block exists
    if !options.is_object() {
        options = json!({});
    }

    let options_obj = options.as_object_mut().unwrap();

    // Ensure block object exists
    if !options_obj.contains_key(&block) {
        options_obj.insert(block.clone(), json!({}));
    }

    // Set the option value
    if let Some(block_obj) = options_obj.get_mut(&block).and_then(|v| v.as_object_mut()) {
        block_obj.insert(option.clone(), value.clone());
    }

    // Save to store
    store_guard.set("backend", options);

    store_guard
        .save()
        .map_err(|e| format!("Failed to save RClone option: {}", e))?;

    info!("✅ RClone option {}.{} saved: {}", block, option, value);
    Ok(())
}

/// **Reset RClone backend options to defaults (empty)**
#[tauri::command]
pub async fn reset_rclone_backend_options(app_handle: AppHandle) -> Result<(), String> {
    debug!("Resetting RClone backend options");

    let backend_store = app_handle
        .try_state::<RCloneBackendStore>()
        .ok_or("RClone backend store not initialized")?;

    let store_guard = backend_store.store.lock().await;

    // Clear all options
    store_guard.set("backend", json!({}));

    store_guard
        .save()
        .map_err(|e| format!("Failed to save reset RClone options: {}", e))?;

    info!("✅ RClone backend options reset successfully");
    Ok(())
}

#[tauri::command]
pub async fn remove_rclone_backend_option(
    app_handle: AppHandle,
    block: String,
    option: String,
) -> Result<(), String> {
    debug!("Removing RClone option: {}.{}", block, option);

    let backend_store = app_handle
        .try_state::<RCloneBackendStore>()
        .ok_or("RClone backend store not initialized")?;

    let store_guard = backend_store.store.lock().await;

    // Load existing options
    let _ = store_guard.reload();
    let mut options = store_guard
        .get("backend")
        .unwrap_or_else(|| json!({}))
        .clone();

    // Ensure it's an object
    if !options.is_object() {
        return Ok(()); // Nothing to remove
    }

    let options_obj = options.as_object_mut().unwrap();

    // Remove the option from the block
    if let Some(block_obj) = options_obj.get_mut(&block).and_then(|v| v.as_object_mut()) {
        block_obj.remove(&option);

        // If the block is now empty, remove the entire block
        if block_obj.is_empty() {
            options_obj.remove(&block);
        }
    }

    // Save to store
    store_guard.set("backend", options);

    store_guard
        .save()
        .map_err(|e| format!("Failed to save RClone options after removal: {}", e))?;

    info!(
        "✅ RClone option {}.{} removed (reset to default)",
        block, option
    );
    Ok(())
}

/// **Get RClone backend store path for backup/export**
#[tauri::command]
pub async fn get_rclone_backend_store_path(
    settings_state: State<'_, SettingsState<tauri::Wry>>,
) -> Result<String, String> {
    let config_dir = &settings_state.config_dir;
    let store_path = config_dir.join("backend.json");
    Ok(store_path.to_string_lossy().to_string())
}
