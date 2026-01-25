//! Startup routines for auto-starting profiles (mount, serve, sync, etc.)
//!
//! This module provides the `handle_startup` function that runs on app startup
//! to automatically start any profiles that are configured with autoStart: true

use crate::core::settings::AppSettingsManager;
use crate::{
    rclone::commands::{
        mount::mount_remote_profile,
        serve::start_serve_profile,
        sync::{start_bisync_profile, start_copy_profile, start_move_profile, start_sync_profile},
    },
    utils::types::remotes::ProfileParams,
};
use log::{error, info, warn};
use tauri::{AppHandle, Manager};

/// Auto-start all profiles that have autoStart: true
/// This is called during app initialization.
/// Profiles are started in parallel for faster startup.
pub async fn handle_startup(app: AppHandle) {
    info!("🚀 Starting auto-start profiles check...");
    let manager = app.state::<AppSettingsManager>();

    use crate::rclone::backend::BackendManager;
    let backend_manager = app.state::<BackendManager>();

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

    // Collect all auto-start tasks to run in parallel
    let mut tasks: Vec<tokio::task::JoinHandle<()>> = Vec::new();

    for (remote_name, settings) in settings_map.iter() {
        // Collect mount profiles
        collect_auto_start_tasks(
            &mut tasks,
            settings,
            "mountConfigs",
            &app,
            remote_name,
            |app, remote, profile| {
                Box::pin(async move { auto_start_mount(&app, &remote, &profile).await })
            },
        );

        // Collect serve profiles
        collect_auto_start_tasks(
            &mut tasks,
            settings,
            "serveConfigs",
            &app,
            remote_name,
            |app, remote, profile| {
                Box::pin(async move { auto_start_serve(&app, &remote, &profile).await })
            },
        );

        // Collect sync/copy/move/bisync profiles
        for (config_key, op_type) in SYNC_PROFILE_TYPES {
            let op = (*op_type).to_string();
            collect_auto_start_tasks(
                &mut tasks,
                settings,
                config_key,
                &app,
                remote_name,
                move |app, remote, profile| {
                    let op = op.clone();
                    Box::pin(async move { auto_start_sync(&app, &remote, &profile, &op).await })
                },
            );
        }
    }

    let task_count = tasks.len();
    if task_count > 0 {
        info!(
            "⚡ Starting {} auto-start profile(s) in parallel...",
            task_count
        );

        // Run all tasks in parallel and wait for completion
        let _ = futures::future::join_all(tasks).await;
    }

    info!("✅ Auto-start profiles check complete");
}

/// Helper to collect auto-start tasks for parallel execution
fn collect_auto_start_tasks<F>(
    tasks: &mut Vec<tokio::task::JoinHandle<()>>,
    settings: &serde_json::Value,
    config_key: &str,
    app: &AppHandle,
    remote_name: &str,
    starter: F,
) where
    F: Fn(
            AppHandle,
            String,
            String,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>
        + Clone
        + Send
        + 'static,
{
    if let Some(configs) = settings.get(config_key).and_then(|v| v.as_object()) {
        for (profile_name, config) in configs {
            if config
                .get("autoStart")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                let app = app.clone();
                let remote = remote_name.to_string();
                let profile = profile_name.clone();
                let starter = starter.clone();

                tasks.push(tokio::spawn(async move {
                    starter(app, remote, profile).await;
                }));
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

    let result = match op_type {
        "sync" => start_sync_profile(app.clone(), params).await.map(|_| ()),
        "copy" => start_copy_profile(app.clone(), params).await.map(|_| ()),
        "move" => start_move_profile(app.clone(), params).await.map(|_| ()),
        "bisync" => start_bisync_profile(app.clone(), params).await.map(|_| ()),
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
