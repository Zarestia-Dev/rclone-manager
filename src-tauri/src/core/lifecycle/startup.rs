use log::{debug, error, info};
use tauri::{AppHandle, Manager};

use crate::{
    RcloneState,
    rclone::commands::{
        mount::{MountParams, mount_remote},
        serve::{ServeParams, start_serve},
        sync::{
            BisyncParams, CopyParams, MoveParams, SyncParams, start_bisync, start_copy, start_move,
            start_sync,
        },
    },
    utils::types::all_types::{JobCache, RemoteCache},
};

/// Main entry point for handling startup tasks.
pub async fn handle_startup(app_handle: AppHandle) {
    info!("🚀 Checking startup options...");

    // --- Get RemoteCache from app_handle ---
    let cache = app_handle.state::<RemoteCache>();

    // Initialize remotes
    let remotes = match cache.get_remotes().await {
        // <-- Use cache method
        r if !r.is_empty() => r,
        _ => {
            error!("Failed to get remotes or no remotes found");
            return;
        }
    };

    for remote in remotes {
        handle_remote_startup(&remote, app_handle.clone(), cache.clone()).await;
    }
}

/// Handles startup logic for an individual remote.
async fn handle_remote_startup(
    remote_name: &str,
    app_handle: AppHandle,
    cache: tauri::State<'_, RemoteCache>,
) {
    let settings_val = cache.get_settings().await;
    let settings = match settings_val.get(remote_name).cloned() {
        Some(s) => s,
        None => {
            error!("Remote {} not found in cached settings", remote_name);
            return;
        }
    };

    let job_cache_state = app_handle.state::<JobCache>();
    let rclone_state = app_handle.state::<RcloneState>();

    // --- Handle mount operation ---
    if MountParams::should_auto_start(&settings) {
        match MountParams::from_settings(remote_name.to_string(), &settings) {
            Some(params) => {
                if let Err(e) =
                    mount_remote(app_handle.clone(), job_cache_state.clone(), cache, params).await
                {
                    error!("Failed to auto-start mount for {}: {}", remote_name, e);
                } else {
                    debug!("Mount task spawned for {}", remote_name);
                }
            }
            None => error!("❌ Mount configuration incomplete for {}", remote_name),
        }
    }

    // --- Handle sync operation ---
    if SyncParams::should_auto_start(&settings) {
        match SyncParams::from_settings(remote_name.to_string(), &settings) {
            Some(params) => {
                if let Err(e) = start_sync(
                    app_handle.clone(),
                    job_cache_state.clone(),
                    rclone_state.clone(),
                    params,
                )
                .await
                {
                    error!("Failed to auto-start sync for {}: {}", remote_name, e);
                } else {
                    debug!("Sync task spawned for {}", remote_name);
                }
            }
            None => error!("❌ Sync configuration incomplete for {}", remote_name),
        }
    }

    // --- Handle copy operation ---
    if CopyParams::should_auto_start(&settings) {
        match CopyParams::from_settings(remote_name.to_string(), &settings) {
            Some(params) => {
                if let Err(e) = start_copy(
                    app_handle.clone(),
                    job_cache_state.clone(),
                    rclone_state.clone(),
                    params,
                )
                .await
                {
                    error!("Failed to auto-start copy for {}: {}", remote_name, e);
                } else {
                    debug!("Copy task spawned for {}", remote_name);
                }
            }
            None => error!("❌ Copy configuration incomplete for {}", remote_name),
        }
    }

    // --- Handle move operation ---
    if MoveParams::should_auto_start(&settings) {
        match MoveParams::from_settings(remote_name.to_string(), &settings) {
            Some(params) => {
                if let Err(e) = start_move(
                    app_handle.clone(),
                    job_cache_state.clone(),
                    rclone_state.clone(),
                    params,
                )
                .await
                {
                    error!("Failed to auto-start move for {}: {}", remote_name, e);
                } else {
                    debug!("Move task spawned for {}", remote_name);
                }
            }
            None => error!("❌ Move configuration incomplete for {}", remote_name),
        }
    }

    // --- Handle bisync operation ---
    if BisyncParams::should_auto_start(&settings) {
        match BisyncParams::from_settings(remote_name.to_string(), &settings) {
            Some(params) => {
                if let Err(e) = start_bisync(
                    app_handle.clone(),
                    job_cache_state.clone(),
                    rclone_state.clone(),
                    params,
                )
                .await
                {
                    error!("Failed to auto-start bisync for {}: {}", remote_name, e);
                } else {
                    debug!("Bisync task spawned for {}", remote_name);
                }
            }
            None => error!("❌ Bisync configuration incomplete for {}", remote_name),
        }
    }

    // --- Handle serve operation ---
    if ServeParams::should_auto_start(&settings) {
        match ServeParams::from_settings(remote_name.to_string(), &settings) {
            Some(params) => {
                if let Err(e) = start_serve(app_handle.clone(), params).await {
                    error!("Failed to auto-start serve for {}: {}", remote_name, e);
                } else {
                    debug!("Serve task spawned for {}", remote_name);
                }
            }
            None => error!("❌ Serve configuration incomplete for {}", remote_name),
        }
    }
}
