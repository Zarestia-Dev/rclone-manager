use log::{debug, error, info, warn};
use tauri::{AppHandle, Manager, Runtime};
use tokio::join;

use crate::{
    rclone::api::api::{get_remotes, mount_remote},
    RcloneState,
};

use super::settings::settings::get_remote_settings;

/// Main entry point for handling startup tasks.
pub async fn handle_startup<R: Runtime>(app_handle: &AppHandle<R>) {
    info!("🚀 Checking startup options...");

    let rclone_state = app_handle.state::<RcloneState>();

    // Run both tasks in parallel
    let (remotes_result, sync_result) = join!(
        initialize_remotes::<R>(rclone_state),
        sync_all_remotes(app_handle)
    );

    // Process remotes after retrieval
    if let Ok(remotes) = remotes_result {
        for remote in remotes.iter() {
            handle_remote_startup(remote.to_string(), app_handle).await;
        }
    }

    // Handle any errors from sync_all_remotes
    if let Err(err) = sync_result {
        error!("❌ Sync task failed: {}", err);
    }
}

/// Fetches the list of available remotes.
async fn initialize_remotes<R: Runtime>(
    rclone_state: tauri::State<'_, RcloneState>,
) -> Result<Vec<String>, String> {
    get_remotes(rclone_state).await
}

/// Handles startup logic for an individual remote.
async fn handle_remote_startup<R: Runtime>(remote_name: String, app_handle: &AppHandle<R>) {
    match get_remote_settings(remote_name.clone(), app_handle.state()).await {
        Ok(settings) => {
            let mount_options = settings.get("mount_options").cloned();
            let vfs_options = settings.get("vfs_options").cloned();

            if let Some(auto_mount) = mount_options
                .as_ref()
                .and_then(|opts| opts.get("auto_mount").and_then(|v| v.as_bool()))
            {
                if !auto_mount {
                    debug!("Skipping mount for {}: auto_mount is not true", remote_name);
                    return;
                }

                let mount_point = mount_options
                    .as_ref()
                    .and_then(|opts| opts.get("mount_point").and_then(|v| v.as_str()))
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| format!("/mnt/{}", remote_name));

                spawn_mount_task(
                    remote_name,
                    mount_point,
                    mount_options,
                    vfs_options,
                    app_handle,
                );
            }
        }
        Err(e) => warn!("⚠️ Failed to load settings for '{}': {}", remote_name, e),
    }
}

/// Spawns an async task to mount a remote.
fn spawn_mount_task<R: Runtime>(
    remote_name: String,
    mount_point: String,
    mount_options: Option<serde_json::Value>,
    vfs_options: Option<serde_json::Value>,
    app_handle: &AppHandle<R>,
) {
    let app_clone = app_handle.clone();
    let mount_options_clone = mount_options
        .as_ref()
        .and_then(|o| o.as_object().cloned())
        .map(|map| map.into_iter().collect());

    let vfs_options_clone = vfs_options
        .as_ref()
        .and_then(|o| o.as_object().cloned())
        .map(|map| map.into_iter().collect());

    tauri::async_runtime::spawn(async move {
        match mount_remote(
            remote_name.clone(),
            mount_point,
            mount_options_clone,
            vfs_options_clone,
            app_clone.state(),
        )
        .await
        {
            Ok(_) => info!("✅ Mounted {}", remote_name),
            Err(err) => error!("❌ Failed to mount {}: {}", remote_name, err),
        }
    });
}

/// Runs sync jobs for all remotes.
async fn sync_all_remotes<R: Runtime>(_app_handle: &AppHandle<R>) -> Result<(), String> {
    info!("🔄 Starting remote sync tasks...");

    debug!("🧪 For testing.");

    // sleep(Duration::from_secs(5)).await;

    Ok(())
}
