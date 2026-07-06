use log::debug;
use serde_json::Value;

use crate::utils::{
    rclone::endpoints::serve,
    types::{remotes::ServeInstance, state::RcloneState},
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
pub async fn get_serve_types(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    use tauri::Manager;

    let json = app
        .state::<RcloneState>()
        .transport
        .rpc(serve::TYPES, None)
        .await
        .map_err(|e| format!("Failed to fetch serve types: {e}"))?;

    let serve_types = json["types"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .filter_map(|st| st.as_str().map(String::from))
        .collect();

    debug!("✅ Serve types: {serve_types:?}");

    Ok(serve_types)
}

#[tauri::command]
pub async fn list_serves(app: tauri::AppHandle) -> Result<Vec<ServeInstance>, String> {
    use tauri::Manager;

    let json = app
        .state::<RcloneState>()
        .transport
        .rpc(serve::LIST, None)
        .await
        .map_err(|e| format!("Failed to list serves: {e}"))?;

    debug!("✅ Running serves: {json}");

    Ok(parse_serves_response(&json))
}
