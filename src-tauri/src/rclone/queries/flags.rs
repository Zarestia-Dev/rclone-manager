use serde_json::{Value, json};
use std::error::Error;
use tauri::{State, command};

use crate::{
    RcloneState,
    rclone::state::ENGINE_STATE,
    utils::rclone::endpoints::{EndpointHelper, options},
};

/// Fetch all RClone options info at once (optimization: single API call)
async fn fetch_all_options_info(state: State<'_, RcloneState>) -> Result<Value, Box<dyn Error>> {
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, options::INFO);

    let response = state.client.post(&url).json(&json!({})).send().await?;

    if response.status().is_success() {
        let json: Value = response.json().await?;
        Ok(json)
    } else {
        Err(format!("Failed to fetch options info: {:?}", response.text().await?).into())
    }
}

/// Fetch current RClone option values
async fn fetch_current_options(state: State<'_, RcloneState>) -> Result<Value, Box<dyn Error>> {
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, options::GET);

    let response = state.client.post(&url).json(&json!({})).send().await?;

    if response.status().is_success() {
        let json: Value = response.json().await?;
        Ok(json)
    } else {
        Err(format!(
            "Failed to fetch current options: {:?}",
            response.text().await?
        )
        .into())
    }
}

/// Fetch available option blocks/categories
async fn fetch_option_blocks(state: State<'_, RcloneState>) -> Result<Value, Box<dyn Error>> {
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, options::BLOCKS);

    let response = state.client.post(&url).json(&json!({})).send().await?;

    if response.status().is_success() {
        let json: Value = response.json().await?;
        Ok(json)
    } else {
        Err(format!(
            "Failed to fetch option blocks: {:?}",
            response.text().await?
        )
        .into())
    }
}

/// Get all available option blocks/categories
#[command]
pub async fn get_option_blocks(state: State<'_, RcloneState>) -> Result<Value, String> {
    fetch_option_blocks(state).await.map_err(|e| e.to_string())
}

/// Get all RClone options info (metadata about all flags)
#[command]
pub async fn get_all_options_info(state: State<'_, RcloneState>) -> Result<Value, String> {
    fetch_all_options_info(state)
        .await
        .map_err(|e| e.to_string())
}

/// Get current RClone option values (all categories)
#[command]
pub async fn get_current_options(state: State<'_, RcloneState>) -> Result<Value, String> {
    fetch_current_options(state)
        .await
        .map_err(|e| e.to_string())
}

/// Fetch all global flags (legacy - kept for compatibility)
#[command]
pub async fn get_global_flags(state: State<'_, RcloneState>) -> Result<Value, String> {
    fetch_current_options(state)
        .await
        .map_err(|e| e.to_string())
}

/// Get flags for a specific category with optional filtering
#[command]
pub async fn get_flags_by_category(
    state: State<'_, RcloneState>,
    category: String,
    filter_groups: Option<Vec<String>>,
    exclude_flags: Option<Vec<String>>,
) -> Result<Vec<Value>, String> {
    let json = fetch_all_options_info(state)
        .await
        .map_err(|e| e.to_string())?;

    let empty_vec = vec![];
    let category_flags = json[&category].as_array().unwrap_or(&empty_vec);

    let filtered_flags: Vec<Value> = category_flags
        .iter()
        .filter(|flag| {
            // Check flag name exclusion
            if let Some(ref excludes) = exclude_flags {
                let name = flag["Name"].as_str().unwrap_or("");
                if excludes.contains(&name.to_string()) {
                    return false;
                }
            }

            // Check group filtering
            if let Some(ref groups_filter) = filter_groups {
                if let Some(groups) = flag["Groups"].as_str() {
                    // Include if flag belongs to any of the specified groups
                    return groups_filter.iter().any(|g| groups.contains(g.as_str()));
                }
                // If no groups specified in flag, exclude it when filtering by groups
                return false;
            }

            true
        })
        .cloned()
        .collect();

    Ok(filtered_flags)
}

/// Fetch copy flags (optimized: filters from single API call)
#[command]
pub async fn get_copy_flags(state: State<'_, RcloneState>) -> Result<Vec<Value>, String> {
    get_flags_by_category(
        state,
        "main".to_string(),
        Some(vec!["Copy".to_string(), "Performance".to_string()]),
        None,
    )
    .await
}

/// Fetch sync flags (optimized: filters from single API call)
#[command]
pub async fn get_sync_flags(state: State<'_, RcloneState>) -> Result<Vec<Value>, String> {
    get_flags_by_category(
        state,
        "main".to_string(),
        Some(vec![
            "Copy".to_string(),
            "Sync".to_string(),
            "Performance".to_string(),
        ]),
        None,
    )
    .await
}

/// Fetch filter flags (excluding metadata flags)
#[command]
pub async fn get_filter_flags(state: State<'_, RcloneState>) -> Result<Vec<Value>, String> {
    let json = fetch_all_options_info(state)
        .await
        .map_err(|e| e.to_string())?;

    let empty_vec = vec![];
    let filter_flags = json["filter"].as_array().unwrap_or(&empty_vec);

    // Exclude metadata-related flags
    let filtered: Vec<Value> = filter_flags
        .iter()
        .filter(|flag| {
            !flag["Groups"]
                .as_str()
                .map(|groups| groups.contains("Metadata"))
                .unwrap_or(false)
        })
        .cloned()
        .collect();

    Ok(filtered)
}

/// Fetch VFS flags (excluding unsupported flags)
#[command]
pub async fn get_vfs_flags(state: State<'_, RcloneState>) -> Result<Vec<Value>, String> {
    get_flags_by_category(
        state,
        "vfs".to_string(),
        None,
        Some(vec!["NONE".to_string()]), // Exclude "NONE" flag as it's not supported
    )
    .await
}

/// Fetch mount flags (excluding unsupported flags)
#[command]
pub async fn get_mount_flags(state: State<'_, RcloneState>) -> Result<Vec<Value>, String> {
    get_flags_by_category(
        state,
        "mount".to_string(),
        None,
        Some(vec![
            "debug_fuse".to_string(),
            "daemon".to_string(),
            "daemon_timeout".to_string(),
        ]), // These flags are not supported via API
    )
    .await
}

/// Set a single RClone option value
///
/// RClone API expects options grouped by block:
/// ```json
/// {
///   "block_name": {
///     "option_name": value
///   }
/// }
/// ```
#[command]
pub async fn set_rclone_option(
    state: State<'_, RcloneState>,
    block_name: String,
    option_name: String,
    value: Value,
) -> Result<Value, String> {
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, options::SET);

    // Build the request payload grouped by block
    // Format: { "block_name": { "option_name": value } }
    let payload = json!({
        block_name.clone(): {
            option_name.clone(): value
        }
    });

    let response = state
        .client
        .post(&url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Failed to send request: {}", e))?;

    if response.status().is_success() {
        let json: Value = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {}", e))?;
        Ok(json)
    } else {
        let error_text = response
            .text()
            .await
            .unwrap_or_else(|_| "Unknown error".to_string());
        Err(format!(
            "Failed to set option '{}' in block '{}': {}",
            option_name, block_name, error_text
        ))
    }
}
