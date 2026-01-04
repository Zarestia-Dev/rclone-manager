use log::debug;
use serde_json::Value;
use tauri::State;

use crate::{
    rclone::backend::{BACKEND_MANAGER, types::Backend},
    utils::{
        rclone::endpoints::{EndpointHelper, serve},
        types::{core::RcloneState, remotes::ServeInstance},
    },
};

/// Parse serves list from API JSON response
pub fn parse_serves_response(response: &Value) -> Vec<ServeInstance> {
    response
        .get("list")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    let id = item.get("id")?.as_str()?.to_string();
                    let addr = item.get("addr")?.as_str()?.to_string();
                    let params = item.get("params")?.clone();

                    Some(ServeInstance {
                        id,
                        addr,
                        params,
                        profile: None,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Get all supported serve types from rclone
#[tauri::command]
pub async fn get_serve_types(state: State<'_, RcloneState>) -> Result<Vec<String>, String> {
    let backend = BACKEND_MANAGER.get_active().await;
    let url = EndpointHelper::build_url(&backend.api_url(), serve::TYPES);

    debug!("🔍 Fetching serve types from {url}");

    let response = backend
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
    backend: &Backend,
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

#[cfg(not(feature = "web-server"))]
#[tauri::command]
pub async fn list_serves(state: State<'_, RcloneState>) -> Result<Value, String> {
    let backend = BACKEND_MANAGER.get_active().await;
    list_serves_internal(&state.client, &backend).await
}
