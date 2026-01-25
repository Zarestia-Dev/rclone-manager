use log::debug;
use serde_json::Value;

use crate::{
    rclone::backend::types::Backend,
    utils::{
        rclone::endpoints::serve,
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
pub async fn get_serve_types(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    use crate::rclone::backend::BackendManager;
    use tauri::Manager;
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;

    let json = backend
        .post_json(&app.state::<RcloneState>().client, serve::TYPES, None)
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

/// List all currently running serve instances
pub async fn list_serves_internal(
    client: &reqwest::Client,
    backend: &Backend,
) -> Result<Value, String> {
    let json = backend
        .post_json(client, serve::LIST, None)
        .await
        .map_err(|e| format!("Failed to list serves: {e}"))?;

    debug!("✅ Running serves: {json}");

    Ok(json)
}

#[cfg(not(feature = "web-server"))]
#[tauri::command]
pub async fn list_serves(app: tauri::AppHandle) -> Result<Value, String> {
    use crate::rclone::backend::BackendManager;
    use tauri::Manager;
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    list_serves_internal(&app.state::<RcloneState>().client, &backend).await
}
