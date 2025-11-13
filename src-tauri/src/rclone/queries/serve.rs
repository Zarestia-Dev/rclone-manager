use log::debug;
use serde_json::Value;
use tauri::State;

use crate::{
    RcloneState,
    rclone::engine::core::ENGINE,
    utils::rclone::endpoints::{EndpointHelper, options, serve},
};

/// Get all supported serve types from rclone
#[tauri::command]
pub async fn get_serve_types(state: State<'_, RcloneState>) -> Result<Vec<String>, String> {
    let api_url = ENGINE.lock().await.get_api_url();
    let url = EndpointHelper::build_url(&api_url, serve::TYPES);

    debug!("🔍 Fetching serve types from {url}");

    let response = state
        .client
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to send request: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to fetch serve types: {:?}",
            response.text().await
        ));
    }

    let json: Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {e}"))?;

    let serve_types = json["types"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .filter_map(|st| st.as_str().map(String::from))
        .collect();

    debug!("✅ Serve types: {serve_types:?}");

    Ok(serve_types)
}

/// List all currently running serve instances
#[tauri::command]
pub async fn list_serves(state: State<'_, RcloneState>) -> Result<Value, String> {
    let api_url = ENGINE.lock().await.get_api_url();
    let url = EndpointHelper::build_url(&api_url, serve::LIST);

    debug!("🔍 Listing running serves from {url}");

    let response = state
        .client
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to send request: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to list serves: {:?}",
            response.text().await
        ));
    }

    let json: Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {e}"))?;

    debug!("✅ Running serves: {json}");

    Ok(json)
}

/// Get flags/options for a specific serve type
/// Similar to mount/vfs flags, this returns the configuration options available for a serve type
#[tauri::command]
pub async fn get_serve_flags(
    serve_type: String,
    state: State<'_, RcloneState>,
) -> Result<Vec<Value>, String> {
    let api_url = ENGINE.lock().await.get_api_url();
    let url = EndpointHelper::build_url(&api_url, options::INFO);

    debug!("🔍 Fetching serve flags for type '{serve_type}' from {url}");

    let response = state
        .client
        .post(&url)
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|e| format!("Failed to send request: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to fetch serve flags: {:?}",
            response.text().await
        ));
    }

    let json: Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {e}"))?;

    // Get the flags for the specific serve type as a Vec<Value>
    let serve_flags_array = json
        .get(&serve_type)
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_else(Vec::new); // Get it as a Vec<Value>

    // Iterate and modify the FieldName
    let modified_flags: Vec<Value> = serve_flags_array
        .into_iter()
        .map(|mut flag| {
            if let Some(field_name) = flag["FieldName"].as_str()
                && let Some(last_part) = field_name.split('.').next_back()
            {
                // Set FieldName to only the part after the dot
                flag["FieldName"] = Value::String(last_part.to_string());
            }
            flag
        })
        .collect();

    debug!("✅ Modified serve flags for '{serve_type}': {modified_flags:?}");

    Ok(modified_flags)
}
