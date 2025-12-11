use log::{error, info};
use tauri::{AppHandle, Manager};

use crate::{
    rclone::commands::{
        mount::{MountParams, mount_remote},
        serve::{ServeParams, start_serve},
        sync::{
            BisyncParams, CopyParams, MoveParams, SyncParams, start_bisync, start_copy, start_move,
            start_sync,
        },
    },
    utils::types::all_types::{JobCache, RcloneState, RemoteCache},
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

    // --- Handle mount operations (multi-config support) ---
    if let Some(mount_configs) = settings.get("mountConfigs").and_then(|v| v.as_array()) {
        for mount_config in mount_configs {
            if mount_config
                .get("autoStart")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                // Create a temporary settings object with the selected profile as the active config
                let mut temp_settings = settings.clone();
                temp_settings["mountConfig"] = mount_config.clone();

                match MountParams::from_settings(remote_name.to_string(), &temp_settings) {
                    Some(params) => {
                        info!(
                            "🚀 Auto-starting mount profile '{}' for {}",
                            params.profile.as_ref().unwrap_or(&"default".to_string()),
                            remote_name
                        );
                        if let Err(e) = mount_remote(
                            app_handle.clone(),
                            job_cache_state.clone(),
                            cache.clone(),
                            params,
                        )
                        .await
                        {
                            error!("Failed to auto-start mount for {}: {}", remote_name, e);
                        }
                    }
                    None => error!("❌ Mount configuration incomplete for {}", remote_name),
                }
            }
        }
    }

    // --- Handle sync operations (multi-config support) ---
    if let Some(sync_configs) = settings.get("syncConfigs").and_then(|v| v.as_array()) {
        for sync_config in sync_configs {
            if sync_config
                .get("autoStart")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                let mut temp_settings = settings.clone();
                temp_settings["syncConfig"] = sync_config.clone();

                match SyncParams::from_settings(remote_name.to_string(), &temp_settings) {
                    Some(params) => {
                        info!(
                            "🚀 Auto-starting sync profile '{}' for {}",
                            params.profile.as_ref().unwrap_or(&"default".to_string()),
                            remote_name
                        );
                        if let Err(e) = start_sync(
                            app_handle.clone(),
                            job_cache_state.clone(),
                            rclone_state.clone(),
                            params,
                        )
                        .await
                        {
                            error!("Failed to auto-start sync for {}: {}", remote_name, e);
                        }
                    }
                    None => error!("❌ Sync configuration incomplete for {}", remote_name),
                }
            }
        }
    }

    // --- Handle copy operations (multi-config support) ---
    if let Some(copy_configs) = settings.get("copyConfigs").and_then(|v| v.as_array()) {
        for copy_config in copy_configs {
            if copy_config
                .get("autoStart")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                let mut temp_settings = settings.clone();
                temp_settings["copyConfig"] = copy_config.clone();

                match CopyParams::from_settings(remote_name.to_string(), &temp_settings) {
                    Some(params) => {
                        info!(
                            "🚀 Auto-starting copy profile '{}' for {}",
                            params.profile.as_ref().unwrap_or(&"default".to_string()),
                            remote_name
                        );
                        if let Err(e) = start_copy(
                            app_handle.clone(),
                            job_cache_state.clone(),
                            rclone_state.clone(),
                            params,
                        )
                        .await
                        {
                            error!("Failed to auto-start copy for {}: {}", remote_name, e);
                        }
                    }
                    None => error!("❌ Copy configuration incomplete for {}", remote_name),
                }
            }
        }
    }

    // --- Handle move operations (multi-config support) ---
    if let Some(move_configs) = settings.get("moveConfigs").and_then(|v| v.as_array()) {
        for move_config in move_configs {
            if move_config
                .get("autoStart")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                let mut temp_settings = settings.clone();
                temp_settings["moveConfig"] = move_config.clone();

                match MoveParams::from_settings(remote_name.to_string(), &temp_settings) {
                    Some(params) => {
                        info!(
                            "🚀 Auto-starting move profile '{}' for {}",
                            params.profile.as_ref().unwrap_or(&"default".to_string()),
                            remote_name
                        );
                        if let Err(e) = start_move(
                            app_handle.clone(),
                            job_cache_state.clone(),
                            rclone_state.clone(),
                            params,
                        )
                        .await
                        {
                            error!("Failed to auto-start move for {}: {}", remote_name, e);
                        }
                    }
                    None => error!("❌ Move configuration incomplete for {}", remote_name),
                }
            }
        }
    }

    // --- Handle bisync operations (multi-config support) ---
    if let Some(bisync_configs) = settings.get("bisyncConfigs").and_then(|v| v.as_array()) {
        for bisync_config in bisync_configs {
            if bisync_config
                .get("autoStart")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                let mut temp_settings = settings.clone();
                temp_settings["bisyncConfig"] = bisync_config.clone();

                match BisyncParams::from_settings(remote_name.to_string(), &temp_settings) {
                    Some(params) => {
                        info!(
                            "🚀 Auto-starting bisync profile '{}' for {}",
                            params.profile.as_ref().unwrap_or(&"default".to_string()),
                            remote_name
                        );
                        if let Err(e) = start_bisync(
                            app_handle.clone(),
                            job_cache_state.clone(),
                            rclone_state.clone(),
                            params,
                        )
                        .await
                        {
                            error!("Failed to auto-start bisync for {}: {}", remote_name, e);
                        }
                    }
                    None => error!("❌ Bisync configuration incomplete for {}", remote_name),
                }
            }
        }
    }

    // --- Handle serve operations (multi-config support) ---
    if let Some(serve_configs) = settings.get("serveConfigs").and_then(|v| v.as_array()) {
        for serve_config in serve_configs {
            if serve_config
                .get("autoStart")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                let mut temp_settings = settings.clone();
                temp_settings["serveConfig"] = serve_config.clone();

                match ServeParams::from_settings(remote_name.to_string(), &temp_settings) {
                    Some(params) => {
                        info!(
                            "🚀 Auto-starting serve profile '{}' for {}",
                            params.profile.as_ref().unwrap_or(&"default".to_string()),
                            remote_name
                        );
                        if let Err(e) =
                            start_serve(app_handle.clone(), job_cache_state.clone(), params).await
                        {
                            error!("Failed to auto-start serve for {}: {}", remote_name, e);
                        }
                    }
                    None => error!("❌ Serve configuration incomplete for {}", remote_name),
                }
            }
        }
    }
}
