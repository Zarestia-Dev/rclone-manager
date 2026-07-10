//! Startup routines for auto-starting profiles (mount, serve, sync, etc.)
//!
//! This module provides the `handle_startup` function that runs on app startup
//! to automatically start any profiles that are configured with autoStart: true

use crate::core::settings::AppSettingsManager;
use crate::{
    rclone::commands::{
        mount::mount_remote_profile, serve::start_serve_profile, sync::start_profile_batch,
    },
    utils::{
        types::origin::Origin,
        types::remotes::{OperationType, ProfileConfig, ProfileParams, RemoteSettings},
    },
};
use log::{error, info, warn};
use std::collections::HashMap;
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
    let settings_map = RemoteSettings::load_all(manager.inner(), &remote_names);

    let mut tasks: Vec<tokio::task::JoinHandle<()>> = Vec::new();

    for (remote_name, settings) in &settings_map {
        // Mount and serve have dedicated entry points.
        push_auto_start_tasks(
            &mut tasks,
            &app,
            remote_name,
            &settings.mount_configs,
            Op::Mount,
        );
        push_auto_start_tasks(
            &mut tasks,
            &app,
            remote_name,
            &settings.serve_configs,
            Op::Serve,
        );

        // All transfer-style operations share `auto_start_sync`.
        push_auto_start_tasks(
            &mut tasks,
            &app,
            remote_name,
            &settings.sync_configs,
            Op::Sync("sync"),
        );
        push_auto_start_tasks(
            &mut tasks,
            &app,
            remote_name,
            &settings.copy_configs,
            Op::Sync("copy"),
        );
        push_auto_start_tasks(
            &mut tasks,
            &app,
            remote_name,
            &settings.move_configs,
            Op::Sync("move"),
        );
        push_auto_start_tasks(
            &mut tasks,
            &app,
            remote_name,
            &settings.bisync_configs,
            Op::Sync("bisync"),
        );
        push_auto_start_tasks(
            &mut tasks,
            &app,
            remote_name,
            &settings.check_configs,
            Op::Sync("check"),
        );
        push_auto_start_tasks(
            &mut tasks,
            &app,
            remote_name,
            &settings.delete_configs,
            Op::Sync("delete"),
        );
        push_auto_start_tasks(
            &mut tasks,
            &app,
            remote_name,
            &settings.copyurl_configs,
            Op::Sync("copyurl"),
        );
        push_auto_start_tasks(
            &mut tasks,
            &app,
            remote_name,
            &settings.archivecreate_configs,
            Op::Sync("archivecreate"),
        );
        push_auto_start_tasks(
            &mut tasks,
            &app,
            remote_name,
            &settings.cryptcheck_configs,
            Op::Sync("cryptcheck"),
        );
    }

    let task_count = tasks.len();
    if task_count > 0 {
        info!("Starting {task_count} auto-start profile(s) in parallel...");

        let _ = futures::future::join_all(tasks).await;
    }

    info!("Auto-start profiles check complete");
}

/// Which auto-start entry point to use for a profile.
#[derive(Clone, Copy)]
enum Op {
    Mount,
    Serve,
    /// Transfers go through `start_profile_batch` with the given op-type string.
    Sync(&'static str),
}

/// Iterate a profile-config map, spawning a task for every profile with
/// `app.auto_start == true`. Centralizes the 11 nearly-identical blocks that
/// previously lived inline in `handle_startup`.
fn push_auto_start_tasks(
    tasks: &mut Vec<tokio::task::JoinHandle<()>>,
    app: &AppHandle,
    remote_name: &str,
    configs: &Option<HashMap<String, ProfileConfig>>,
    op: Op,
) {
    let Some(map) = configs else {
        return;
    };
    for (pname, cfg) in map {
        if !cfg.app.auto_start {
            continue;
        }
        let app = app.clone();
        let remote = remote_name.to_string();
        let profile = pname.clone();
        tasks.push(tokio::spawn(async move {
            match op {
                Op::Mount => auto_start_mount(&app, &remote, &profile).await,
                Op::Serve => auto_start_serve(&app, &remote, &profile).await,
                Op::Sync(op_type) => auto_start_sync(&app, &remote, &profile, op_type).await,
            }
        }));
    }
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
        "sync" => OperationType::Sync,
        "copy" => OperationType::Copy,
        "move" => OperationType::Move,
        "bisync" => OperationType::Bisync,
        "check" => OperationType::Check,
        "delete" => OperationType::Delete,
        "copyurl" => OperationType::Copyurl,
        "archivecreate" => OperationType::Archivecreate,
        "cryptcheck" => OperationType::Cryptcheck,
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
