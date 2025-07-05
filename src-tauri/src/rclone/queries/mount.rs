use log::debug;
use serde_json::Value;
use tauri::State;

use crate::rclone::state::ENGINE_STATE;
use crate::utils::rclone::endpoints::{mount, EndpointHelper};
use crate::utils::types::MountedRemote;
use crate::RcloneState;

#[tauri::command]
pub async fn get_mounted_remotes(
    state: State<'_, RcloneState>,
) -> Result<Vec<MountedRemote>, String> {
    let url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, mount::LISTMOUNTS);

    let response = state
        .client
        .post(&url)
        .send()
        .await
        .map_err(|e| format!("❌ Failed to send request: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "❌ Failed to fetch mounted remotes: {:?}",
            response.text().await
        ));
    }

    let json: Value = response
        .json()
        .await
        .map_err(|e| format!("❌ Failed to parse response: {}", e))?;

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

    debug!("📂 Mounted Remotes: {:?}", mounts);
    Ok(mounts)
}
