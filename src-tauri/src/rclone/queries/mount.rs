use log::debug;

use crate::utils::rclone::endpoints::mount;
use crate::utils::types::remotes::MountedRemote;
use tauri::AppHandle;

pub async fn get_mounted_remotes(app: AppHandle) -> Result<Vec<MountedRemote>, String> {
    let json = crate::rclone::commands::common::transport(&app)
        .rpc(mount::LISTMOUNTS, None)
        .await
        .map_err(|e| format!("❌ Failed to fetch mounted remotes: {e}"))?;

    let mounts = json["mountPoints"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .filter_map(|mp| {
            Some(MountedRemote {
                fs: mp["Fs"].as_str()?.to_string(),
                mount_point: mp["MountPoint"].as_str()?.to_string(),
                profile: None,
            })
        })
        .collect();

    debug!("📂 Mounted Remotes: {mounts:?}");
    Ok(mounts)
}

#[tauri::command]
pub async fn get_mount_types(app: AppHandle) -> Result<Vec<String>, String> {
    let json = crate::rclone::commands::common::transport(&app)
        .rpc(mount::TYPES, None)
        .await
        .map_err(|e| format!("❌ Failed to fetch mount types: {e}"))?;

    let mount_types = json["mountTypes"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .filter_map(|mt| mt.as_str().map(String::from))
        .collect();

    debug!("📂 Mount Types: {mount_types:?}");
    Ok(mount_types)
}
