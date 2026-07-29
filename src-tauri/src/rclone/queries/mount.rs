use log::debug;
use tauri::AppHandle;
#[cfg(target_os = "android")]
use tauri::Manager;

#[cfg(target_os = "android")]
use crate::rclone::backend::BackendManager;
use crate::utils::rclone::endpoints::mount;
use crate::utils::types::remotes::MountedRemote;

pub async fn get_mounted_remotes(app: AppHandle) -> Result<Vec<MountedRemote>, String> {
    #[cfg(target_os = "android")]
    {
        let backend_manager = app.state::<BackendManager>();
        let mounts = backend_manager.remote_cache.get_mounted_remotes().await;
        debug!("📂 Android SAF Mounted Remotes: {mounts:?}");
        return Ok(mounts);
    }

    #[cfg(not(target_os = "android"))]
    {
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
}

#[tauri::command]
pub async fn get_mount_types(app: AppHandle) -> Result<Vec<String>, String> {
    let json = crate::rclone::commands::common::transport(&app)
        .rpc(mount::TYPES, None)
        .await;

    #[allow(unused_mut)]
    let mut mount_types: Vec<String> = match json {
        Ok(res) => res["mountTypes"]
            .as_array()
            .unwrap_or(&vec![])
            .iter()
            .filter_map(|mt| mt.as_str().map(String::from))
            .collect(),
        Err(_) => vec!["mount".to_string(), "cmount".to_string()],
    };

    #[cfg(target_os = "android")]
    {
        if !mount_types.contains(&"saf".to_string()) {
            mount_types.insert(0, "saf".to_string());
        }
    }

    debug!("📂 Mount Types: {mount_types:?}");
    Ok(mount_types)
}
