use log::debug;
use serde_json::json;
use tauri::State;

use crate::RcloneState;
use crate::rclone::state::engine::ENGINE_STATE;
use crate::utils::rclone::endpoints::{EndpointHelper, operations};

#[tauri::command]
pub async fn mkdir(
    remote: String,
    path: String,
    state: State<'_, RcloneState>,
) -> Result<(), String> {
    debug!("📁 Creating directory: remote={} path={}", remote, path);

    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, operations::MKDIR);

    let params = json!({ "fs": remote, "remote": path });

    let response = state
        .client
        .post(&url)
        .json(&params)
        .send()
        .await
        .map_err(|e| format!("❌ Failed to create directory: {e}"))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        return Err(format!("HTTP {status}: {body}"));
    }

    Ok(())
}

#[tauri::command]
pub async fn cleanup(
    remote: String,
    path: Option<String>,
    state: State<'_, RcloneState>,
) -> Result<(), String> {
    debug!(
        "🧹 Cleanup remote trash: remote={} path={}",
        remote,
        path.as_deref().unwrap_or("")
    );

    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, operations::CLEANUP);

    // Build parameters dynamically: include `remote` only when provided
    let mut params = serde_json::Map::new();
    params.insert("fs".to_string(), json!(remote));
    if let Some(p) = path {
        params.insert("remote".to_string(), json!(p));
    }

    let response = state
        .client
        .post(&url)
        .json(&json!(params))
        .send()
        .await
        .map_err(|e| format!("❌ Failed to cleanup remote: {e}"))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if !status.is_success() {
        return Err(format!("HTTP {status}: {body}"));
    }

    Ok(())
}
