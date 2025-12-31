//! RClone Backend Settings Manager (using rcman sub-settings single-file mode)
//!
//! Manages RClone backend options using rcman's sub-settings with single_file() mode.
//! All backend blocks stored in a single backend.json file.

use log::{debug, info};
use rcman::JsonSettingsManager;
use serde_json::json;
use tauri::State;

// -----------------------------------------------------------------------------
// LOAD BACKEND OPTIONS
// -----------------------------------------------------------------------------

/// Load all RClone backend options from rcman sub-settings (single file)
#[cfg(not(feature = "web-server"))]
#[tauri::command]
pub async fn load_rclone_backend_options(
    manager: State<'_, JsonSettingsManager>,
) -> Result<serde_json::Value, String> {
    debug!("Loading RClone backend options via rcman sub-settings");

    let backend = load_backend_options_sync(manager.inner());

    info!("✅ RClone backend options loaded successfully");
    Ok(backend)
}

/// Sync version for use in initialization
pub fn load_backend_options_sync(manager: &JsonSettingsManager) -> serde_json::Value {
    let sub = match manager.sub_settings("backend") {
        Ok(s) => s,
        Err(_) => return json!({}),
    };

    // Get all block names
    let blocks = sub.list().unwrap_or_default();

    // Build the combined object
    let mut result = serde_json::Map::new();
    for block in blocks {
        if let Ok(value) = sub.get_value(&block) {
            result.insert(block, value);
        }
    }

    json!(result)
}

// -----------------------------------------------------------------------------
// SAVE BACKEND OPTIONS
// -----------------------------------------------------------------------------

/// Save all RClone backend options
#[tauri::command]
pub async fn save_rclone_backend_options(
    manager: State<'_, JsonSettingsManager>,
    options: serde_json::Value,
) -> Result<(), String> {
    debug!("Saving RClone backend options via rcman sub-settings");

    let sub = manager
        .sub_settings("backend")
        .map_err(|e| format!("Failed to get backend sub-settings: {}", e))?;

    // Save each top-level block
    if let Some(obj) = options.as_object() {
        for (block_name, block_value) in obj {
            sub.set(block_name, block_value)
                .map_err(|e| format!("Failed to save block '{}': {}", block_name, e))?;
        }
    }

    info!("✅ RClone backend options saved successfully");
    Ok(())
}

// -----------------------------------------------------------------------------
// SAVE SINGLE OPTION
// -----------------------------------------------------------------------------

/// Save a single RClone backend option (block.option format)
#[tauri::command]
pub async fn save_rclone_backend_option(
    manager: State<'_, JsonSettingsManager>,
    block: String,
    option: String,
    value: serde_json::Value,
) -> Result<(), String> {
    debug!("Saving RClone option: {}.{}", block, option);

    let sub = manager
        .sub_settings("backend")
        .map_err(|e| format!("Failed to get backend sub-settings: {}", e))?;

    // Load existing block or create new
    let mut block_value = sub.get_value(&block).unwrap_or_else(|_| json!({}));

    // Ensure it's an object
    if !block_value.is_object() {
        block_value = json!({});
    }

    // Set the option
    if let Some(obj) = block_value.as_object_mut() {
        obj.insert(option.clone(), value.clone());
    }

    // Save the block
    sub.set(&block, &block_value)
        .map_err(|e| format!("Failed to save block '{}': {}", block, e))?;

    info!("✅ RClone option {}.{} saved: {}", block, option, value);
    Ok(())
}

// -----------------------------------------------------------------------------
// RESET BACKEND OPTIONS
// -----------------------------------------------------------------------------

/// Reset RClone backend options to defaults (delete all)
#[tauri::command]
pub async fn reset_rclone_backend_options(
    manager: State<'_, JsonSettingsManager>,
) -> Result<(), String> {
    debug!("Resetting RClone backend options");

    let sub = manager
        .sub_settings("backend")
        .map_err(|e| format!("Failed to get backend sub-settings: {}", e))?;

    // Delete all blocks
    let blocks = sub.list().unwrap_or_default();
    for block in blocks {
        let _ = sub.delete(&block); // Ignore errors for non-existent
    }

    info!("✅ RClone backend options reset successfully");
    Ok(())
}

// -----------------------------------------------------------------------------
// REMOVE SINGLE OPTION
// -----------------------------------------------------------------------------

/// Remove a single RClone backend option
#[tauri::command]
pub async fn remove_rclone_backend_option(
    manager: State<'_, JsonSettingsManager>,
    block: String,
    option: String,
) -> Result<(), String> {
    debug!("Removing RClone option: {}.{}", block, option);

    let sub = manager
        .sub_settings("backend")
        .map_err(|e| format!("Failed to get backend sub-settings: {}", e))?;

    // Load existing block
    let mut block_value = match sub.get_value(&block) {
        Ok(v) => v,
        Err(_) => return Ok(()), // Block doesn't exist, nothing to remove
    };

    // Ensure it's an object
    if !block_value.is_object() {
        return Ok(());
    }

    // Remove the option
    if let Some(obj) = block_value.as_object_mut() {
        obj.remove(&option);

        // If block is now empty, delete the entire block
        if obj.is_empty() {
            let _ = sub.delete(&block);
        } else {
            sub.set(&block, &block_value)
                .map_err(|e| format!("Failed to save block '{}': {}", block, e))?;
        }
    }

    info!(
        "✅ RClone option {}.{} removed (reset to default)",
        block, option
    );
    Ok(())
}

// -----------------------------------------------------------------------------
// GET BACKEND STORE PATH
// -----------------------------------------------------------------------------

/// Get RClone backend store path for backup/export
#[tauri::command]
pub async fn get_rclone_backend_store_path(
    manager: State<'_, JsonSettingsManager>,
) -> Result<String, String> {
    // Backend is stored in config/backend.json (single file mode)
    let backend_path = manager.inner().config().config_dir.join("backend.json");
    Ok(backend_path.to_string_lossy().to_string())
}
