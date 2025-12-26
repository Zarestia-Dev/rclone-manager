use log::debug;
use serde_json::Value;
use tauri::State;

use crate::{
    rclone::backend::{BACKEND_MANAGER, types::RcloneBackend},
    utils::{
        rclone::endpoints::{EndpointHelper, serve},
        types::all_types::RcloneState,
    },
};

/// Get all supported serve types from rclone
#[tauri::command]
pub async fn get_serve_types(state: State<'_, RcloneState>) -> Result<Vec<String>, String> {
    let backend = BACKEND_MANAGER
        .get_active()
        .await
        .ok_or("No active backend")?;

    let backend_guard = backend.read().await;
    let url = EndpointHelper::build_url(&backend_guard.api_url(), serve::TYPES);

    debug!("🔍 Fetching serve types from {url}");

    let response = backend_guard
        .inject_auth(state.client.post(&url))
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
pub async fn list_serves_internal(
    client: &reqwest::Client,
    backend: &RcloneBackend,
) -> Result<Value, String> {
    let url = EndpointHelper::build_url(&backend.api_url(), serve::LIST);

    debug!("🔍 Listing running serves from {url}");

    let response = backend
        .inject_auth(client.post(&url))
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

#[tauri::command]
pub async fn list_serves(state: State<'_, RcloneState>) -> Result<Value, String> {
    let backend = BACKEND_MANAGER
        .get_active()
        .await
        .ok_or("No active backend")?;
    let backend_guard = backend.read().await;
    list_serves_internal(&state.client, &backend_guard).await
}
