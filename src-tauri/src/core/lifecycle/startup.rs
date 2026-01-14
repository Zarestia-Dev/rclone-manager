//! Startup routines for auto-starting profiles (mount, serve, sync, etc.)
//!
//! This module provides the `handle_startup` function that runs on app startup
//! to automatically start any profiles that are configured with autoStart: true

use crate::core::settings::AppSettingsManager;
use log::{error, info, warn};
use tauri::{AppHandle, Manager};

use crate::{
    rclone::commands::{
        mount::mount_remote_profile,
        serve::start_serve_profile,
        sync::{start_bisync_profile, start_copy_profile, start_move_profile, start_sync_profile},
    },
    utils::types::{core::RcloneState, remotes::ProfileParams},
};

/// Auto-start all profiles that have autoStart: true
/// This is called during app initialization
pub async fn handle_startup(app: AppHandle) {
    info!("🚀 Starting auto-start profiles check...");

    let manager = app.state::<AppSettingsManager>();

    let backend_manager = &crate::rclone::backend::BACKEND_MANAGER;

    let remote_names = backend_manager.remote_cache.get_remotes().await;
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

    // Profile type definitions: (config_key, op_type)
    const SYNC_PROFILE_TYPES: &[(&str, &str)] = &[
        ("syncConfigs", "sync"),
        ("copyConfigs", "copy"),
        ("moveConfigs", "move"),
        ("bisyncConfigs", "bisync"),
    ];

    for (remote_name, settings) in settings_map.iter() {
        // Auto-start mount profiles
        check_and_start_profiles(settings, "mountConfigs", |profile_name| {
            let app = app.clone();
            let remote = remote_name.clone();
            async move { auto_start_mount(&app, &remote, &profile_name).await }
        })
        .await;

        // Auto-start serve profiles
        check_and_start_profiles(settings, "serveConfigs", |profile_name| {
            let app = app.clone();
            let remote = remote_name.clone();
            async move { auto_start_serve(&app, &remote, &profile_name).await }
        })
        .await;

        // Auto-start sync/copy/move/bisync profiles (unified loop)
        for (config_key, op_type) in SYNC_PROFILE_TYPES {
            check_and_start_profiles(settings, config_key, |profile_name| {
                let app = app.clone();
                let remote = remote_name.clone();
                let op = op_type.to_string();
                async move { auto_start_sync(&app, &remote, &profile_name, &op).await }
            })
            .await;
        }
    }

    info!("✅ Auto-start profiles check complete");
}

/// Helper to iterate profiles and start those with autoStart: true
async fn check_and_start_profiles<F, Fut>(
    settings: &serde_json::Value,
    config_key: &str,
    starter: F,
) where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    if let Some(configs) = settings.get(config_key).and_then(|v| v.as_object()) {
        for (profile_name, config) in configs {
            if config
                .get("autoStart")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                starter(profile_name.clone()).await;
            }
        }
    }
}

async fn auto_start_mount(app: &AppHandle, remote_name: &str, profile_name: &str) {
    let params = ProfileParams {
        remote_name: remote_name.to_string(),
        profile_name: profile_name.to_string(),
    };

    match mount_remote_profile(app.clone(), params).await {
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

    let rclone_state = app.state::<RcloneState>();

    let result = match op_type {
        "sync" => start_sync_profile(app.clone(), rclone_state, params)
            .await
            .map(|_| ()),
        "copy" => start_copy_profile(app.clone(), rclone_state, params)
            .await
            .map(|_| ()),
        "move" => start_move_profile(app.clone(), rclone_state, params)
            .await
            .map(|_| ()),
        "bisync" => start_bisync_profile(app.clone(), rclone_state, params)
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
