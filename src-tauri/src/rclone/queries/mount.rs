use log::debug;
use tauri::State;

use crate::rclone::backend::BACKEND_MANAGER;
use crate::rclone::backend::types::Backend;
use crate::utils::rclone::endpoints::mount;
use crate::utils::types::core::RcloneState;
use crate::utils::types::remotes::MountedRemote;

pub async fn get_mounted_remotes_internal(
    client: &reqwest::Client,
    backend: &Backend,
) -> Result<Vec<MountedRemote>, String> {
    let json = backend
        .post_json(client, mount::LISTMOUNTS, None)
        .await
        .map_err(|e| format!("❌ Failed to fetch mounted remotes: {e}"))?;

    let mounts = json["mountPoints"]
        .as_array()
        .unwrap_or(&vec![]) // Default to an empty list if not found
        .iter()
        .filter_map(|mp| {
            Some(MountedRemote {
                fs: mp["Fs"].as_str()?.to_string(),
                mount_point: mp["MountPoint"].as_str()?.to_string(),
                profile: None, // Profile not stored in rclone API - tracked separately
            })
        })
        .collect();

    debug!("📂 Mounted Remotes: {mounts:?}");
    Ok(mounts)
}

#[tauri::command]
pub async fn get_mounted_remotes(
    state: State<'_, RcloneState>,
) -> Result<Vec<MountedRemote>, String> {
    let backend = BACKEND_MANAGER.get_active().await;
    get_mounted_remotes_internal(&state.client, &backend).await
}

#[tauri::command]
pub async fn get_mount_types(state: State<'_, RcloneState>) -> Result<Vec<String>, String> {
    let backend = BACKEND_MANAGER.get_active().await;
    let json = backend
        .post_json(&state.client, mount::TYPES, None)
        .await
        .map_err(|e| format!("❌ Failed to fetch mount types: {e}"))?;

    let mount_types = json["mountTypes"]
        .as_array()
        .unwrap_or(&vec![]) // Default to an empty list if not found
        .iter()
        .filter_map(|mt| mt.as_str().map(String::from))
        .collect();

    debug!("📂 Mount Types: {mount_types:?}");
    Ok(mount_types)
}
