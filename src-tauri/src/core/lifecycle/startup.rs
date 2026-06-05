//! Startup routines for auto-starting profiles (mount, serve, sync, etc.)
//!
//! This module provides the `handle_startup` function that runs on app startup
//! to automatically start any profiles that are configured with autoStart: true

use crate::core::settings::AppSettingsManager;
use crate::{
    rclone::commands::{
        mount::mount_remote_profile,
        serve::start_serve_profile,
        sync::{TransferType, start_profile_batch},
    },
    utils::{types::origin::Origin, types::remotes::ProfileParams},
};
use log::{error, info, warn};
use tauri::{AppHandle, Manager};

/// Auto-start all profiles that have autoStart: true
/// This is called during app initialization.
/// Profiles are started in parallel for faster startup.
pub async fn handle_startup(app: AppHandle) {
    info!("Starting auto-start profiles check...");
    let manager = app.state::<AppSettingsManager>();

    use crate::rclone::backend::BackendManager;
    let backend_manager = app.state::<BackendManager>();

    let remote_names = backend_manager.remote_cache.get_remotes().await;
    let settings_map =
        crate::utils::types::remotes::RemoteSettings::load_all(manager.inner(), &remote_names);

    let mut tasks: Vec<tokio::task::JoinHandle<()>> = Vec::new();

    for (remote_name, settings) in &settings_map {
        if let Some(map) = &settings.mount_configs {
            for (pname, cfg) in map {
                if cfg.app.auto_start {
                    let app = app.clone();
                    let remote = remote_name.clone();
                    let profile = pname.clone();
                    tasks.push(tokio::spawn(async move {
                        auto_start_mount(&app, &remote, &profile).await;
                    }));
                }
            }
        }

        if let Some(map) = &settings.serve_configs {
            for (pname, cfg) in map {
                if cfg.app.auto_start {
                    let app = app.clone();
                    let remote = remote_name.clone();
                    let profile = pname.clone();
                    tasks.push(tokio::spawn(async move {
                        auto_start_serve(&app, &remote, &profile).await;
                    }));
                }
            }
        }

        if let Some(map) = &settings.sync_configs {
            for (pname, cfg) in map {
                if cfg.app.auto_start {
                    let app = app.clone();
                    let remote = remote_name.clone();
                    let profile = pname.clone();
                    tasks.push(tokio::spawn(async move {
                        auto_start_sync(&app, &remote, &profile, "sync").await;
                    }));
                }
            }
        }

        if let Some(map) = &settings.copy_configs {
            for (pname, cfg) in map {
                if cfg.app.auto_start {
                    let app = app.clone();
                    let remote = remote_name.clone();
                    let profile = pname.clone();
                    tasks.push(tokio::spawn(async move {
                        auto_start_sync(&app, &remote, &profile, "copy").await;
                    }));
                }
            }
        }

        if let Some(map) = &settings.move_configs {
            for (pname, cfg) in map {
                if cfg.app.auto_start {
                    let app = app.clone();
                    let remote = remote_name.clone();
                    let profile = pname.clone();
                    tasks.push(tokio::spawn(async move {
                        auto_start_sync(&app, &remote, &profile, "move").await;
                    }));
                }
            }
        }

        if let Some(map) = &settings.bisync_configs {
            for (pname, cfg) in map {
                if cfg.app.auto_start {
                    let app = app.clone();
                    let remote = remote_name.clone();
                    let profile = pname.clone();
                    tasks.push(tokio::spawn(async move {
                        auto_start_sync(&app, &remote, &profile, "bisync").await;
                    }));
                }
            }
        }
    }

    let task_count = tasks.len();
    if task_count > 0 {
        info!("Starting {task_count} auto-start profile(s) in parallel...");

        let _ = futures::future::join_all(tasks).await;
    }

    info!("Auto-start profiles check complete");
}

async fn auto_start_mount(app: &AppHandle, remote_name: &str, profile_name: &str) {
    let params = ProfileParams {
        remote_name: remote_name.to_string(),
        profile_name: profile_name.to_string(),
        source: Some(Origin::Startup),
        no_cache: Some(false),
    };

    match mount_remote_profile(app.clone(), params).await {
        Ok(()) => {
            info!("Auto-started mount: {remote_name} profile '{profile_name}'");
        }
        Err(e) => {
            warn!("Failed to auto-start mount {remote_name} profile '{profile_name}': {e}");
        }
    }
}

async fn auto_start_serve(app: &AppHandle, remote_name: &str, profile_name: &str) {
    let params = ProfileParams {
        remote_name: remote_name.to_string(),
        profile_name: profile_name.to_string(),
        source: Some(Origin::Startup),
        no_cache: Some(false),
    };

    match start_serve_profile(app.clone(), params).await {
        Ok(response) => {
            info!(
                "Auto-started serve: {} profile '{}' at {}",
                remote_name, profile_name, response.addr
            );
        }
        Err(e) => {
            warn!("Failed to auto-start serve {remote_name} profile '{profile_name}': {e}");
        }
    }
}

async fn auto_start_sync(app: &AppHandle, remote_name: &str, profile_name: &str, op_type: &str) {
    let params = ProfileParams {
        remote_name: remote_name.to_string(),
        profile_name: profile_name.to_string(),
        source: Some(Origin::Startup),
        no_cache: Some(false),
    };

    let transfer_type = match op_type {
        "sync" => TransferType::Sync,
        "copy" => TransferType::Copy,
        "move" => TransferType::Move,
        "bisync" => TransferType::Bisync,
        _ => {
            error!("Unknown sync type: {op_type}");
            return;
        }
    };

    let result = start_profile_batch(app.clone(), transfer_type, params).await;

    match result {
        Ok(_) => {
            info!("Auto-started {op_type}: {remote_name} profile '{profile_name}'");
        }
        Err(e) => {
            warn!("Failed to auto-start {op_type} {remote_name} profile '{profile_name}': {e}");
        }
    }
}
