use log::debug;
use serde_json::Value;
use tauri::State;

use crate::RcloneState;
use crate::rclone::engine::core::ENGINE;
use crate::utils::rclone::endpoints::{EndpointHelper, mount};
use crate::utils::types::all_types::MountedRemote;

#[tauri::command]
pub async fn get_mounted_remotes(
    state: State<'_, RcloneState>,
) -> Result<Vec<MountedRemote>, String> {
    let api_url = ENGINE.lock().await.get_api_url();
    let url = EndpointHelper::build_url(&api_url, mount::LISTMOUNTS);

    let response = state
        .client
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("❌ Failed to send request: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "❌ Failed to fetch mounted remotes: {:?}",
            response.text().await
        ));
    }

    let json: Value = response
        .json()
        .await
        .map_err(|e| format!("❌ Failed to parse response: {e}"))?;

    let mounts = json["mountPoints"]
        .as_array()
        .unwrap_or(&vec![]) // Default to an empty list if not found
        .iter()
        .filter_map(|mp| {
            Some(MountedRemote {
                fs: mp["Fs"].as_str()?.to_string(),
                mount_point: mp["MountPoint"].as_str()?.to_string(),
            })
        })
        .collect();

    debug!("📂 Mounted Remotes: {mounts:?}");
    Ok(mounts)
}

#[tauri::command]
pub async fn get_mount_types(state: State<'_, RcloneState>) -> Result<Vec<String>, String> {
    let api_url = ENGINE.lock().await.get_api_url();
    let url = EndpointHelper::build_url(&api_url, mount::TYPES);

    let response = state
        .client
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("❌ Failed to send request: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "❌ Failed to fetch mount types: {:?}",
            response.text().await
        ));
    }

    let json: Value = response
        .json()
        .await
        .map_err(|e| format!("❌ Failed to parse response: {e}"))?;

    let mount_types = json["mountTypes"]
        .as_array()
        .unwrap_or(&vec![]) // Default to an empty list if not found
        .iter()
        .filter_map(|mt| mt.as_str().map(String::from))
        .collect();

    debug!("📂 Mount Types: {mount_types:?}");
    Ok(mount_types)
}
