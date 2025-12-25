//! Startup routines for auto-starting profiles (mount, serve, sync, etc.)
//!
//! This module provides the `handle_startup` function that runs on app startup
//! to automatically start any profiles that are configured with autoStart: true

use log::{error, info, warn};
use tauri::{AppHandle, Manager};

use crate::{
    rclone::commands::{
        mount::mount_remote_profile,
        serve::start_serve_profile,
        sync::{start_bisync_profile, start_copy_profile, start_move_profile, start_sync_profile},
    },
    utils::types::all_types::{JobCache, ProfileParams, RcloneState, RemoteCache},
};

/// Auto-start all profiles that have autoStart: true
/// This is called during app initialization
pub async fn handle_startup(app: AppHandle) {
    info!("🚀 Starting auto-start profiles check...");

    let cache = app.state::<RemoteCache>();
    let manager = app.state::<rcman::SettingsManager<rcman::JsonStorage>>();

    let remote_names = cache.get_remotes().await;
    let settings_val = crate::core::settings::remote::manager::get_all_remote_settings_sync(
        manager.inner(),
        &remote_names,
    );

    // settings_val is a serde_json::Value containing remote->settings mapping
    let settings_map = match settings_val.as_object() {
        Some(map) => map,
        None => {
            warn!("⚠️ Settings is not an object, skipping auto-start");
            return;
        }
    };

    for (remote_name, settings) in settings_map.iter() {
        // Auto-start mount profiles
        if let Some(mount_configs) = settings.get("mountConfigs").and_then(|v| v.as_object()) {
            for (profile_name, config) in mount_configs {
                if config
                    .get("autoStart")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
                {
                    auto_start_mount(&app, remote_name, profile_name).await;
                }
            }
        }

        // Auto-start serve profiles
        if let Some(serve_configs) = settings.get("serveConfigs").and_then(|v| v.as_object()) {
            for (profile_name, config) in serve_configs {
                if config
                    .get("autoStart")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
                {
                    auto_start_serve(&app, remote_name, profile_name).await;
                }
            }
        }

        // Auto-start sync profiles
        if let Some(sync_configs) = settings.get("syncConfigs").and_then(|v| v.as_object()) {
            for (profile_name, config) in sync_configs {
                if config
                    .get("autoStart")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
                {
                    auto_start_sync(&app, remote_name, profile_name, "sync").await;
                }
            }
        }

        // Auto-start copy profiles
        if let Some(copy_configs) = settings.get("copyConfigs").and_then(|v| v.as_object()) {
            for (profile_name, config) in copy_configs {
                if config
                    .get("autoStart")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
                {
                    auto_start_sync(&app, remote_name, profile_name, "copy").await;
                }
            }
        }

        // Auto-start move profiles
        if let Some(move_configs) = settings.get("moveConfigs").and_then(|v| v.as_object()) {
            for (profile_name, config) in move_configs {
                if config
                    .get("autoStart")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
                {
                    auto_start_sync(&app, remote_name, profile_name, "move").await;
                }
            }
        }

        // Auto-start bisync profiles
        if let Some(bisync_configs) = settings.get("bisyncConfigs").and_then(|v| v.as_object()) {
            for (profile_name, config) in bisync_configs {
                if config
                    .get("autoStart")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
                {
                    auto_start_sync(&app, remote_name, profile_name, "bisync").await;
                }
            }
        }
    }

    info!("✅ Auto-start profiles check complete");
}

async fn auto_start_mount(app: &AppHandle, remote_name: &str, profile_name: &str) {
    let params = ProfileParams {
        remote_name: remote_name.to_string(),
        profile_name: profile_name.to_string(),
    };

    let cache = app.state::<RemoteCache>();

    match mount_remote_profile(app.clone(), cache, params).await {
        Ok(_) => {
            info!(
                "✅ Auto-started mount: {} profile '{}'",
                remote_name, profile_name
            );
        }
        Err(e) => {
            warn!(
                "⚠️ Failed to auto-start mount {} profile '{}': {}",
                remote_name, profile_name, e
            );
        }
    }
}

async fn auto_start_serve(app: &AppHandle, remote_name: &str, profile_name: &str) {
    let params = ProfileParams {
        remote_name: remote_name.to_string(),
        profile_name: profile_name.to_string(),
    };

    match start_serve_profile(app.clone(), params).await {
        Ok(response) => {
            info!(
                "✅ Auto-started serve: {} profile '{}' at {}",
                remote_name, profile_name, response.addr
            );
        }
        Err(e) => {
            warn!(
                "⚠️ Failed to auto-start serve {} profile '{}': {}",
                remote_name, profile_name, e
            );
        }
    }
}

async fn auto_start_sync(app: &AppHandle, remote_name: &str, profile_name: &str, op_type: &str) {
    let params = ProfileParams {
        remote_name: remote_name.to_string(),
        profile_name: profile_name.to_string(),
    };

    let job_cache = app.state::<JobCache>();
    let rclone_state = app.state::<RcloneState>();

    let result = match op_type {
        "sync" => start_sync_profile(app.clone(), job_cache, rclone_state, params)
            .await
            .map(|_| ()),
        "copy" => start_copy_profile(app.clone(), job_cache, rclone_state, params)
            .await
            .map(|_| ()),
        "move" => start_move_profile(app.clone(), job_cache, rclone_state, params)
            .await
            .map(|_| ()),
        "bisync" => start_bisync_profile(app.clone(), job_cache, rclone_state, params)
            .await
            .map(|_| ()),
        _ => {
            error!("Unknown sync type: {}", op_type);
            return;
        }
    };

    match result {
        Ok(_) => {
            info!(
                "✅ Auto-started {}: {} profile '{}'",
                op_type, remote_name, profile_name
            );
        }
        Err(e) => {
            warn!(
                "⚠️ Failed to auto-start {} {} profile '{}': {}",
                op_type, remote_name, profile_name, e
            );
        }
    }
}
