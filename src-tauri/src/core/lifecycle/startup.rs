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
use log::{info, warn};
use std::collections::HashMap;
use tauri::{AppHandle, Manager};

/// Auto-start all profiles that have autoStart: true
/// This is called during app initialization.
/// Profiles are started in parallel for faster startup.
pub async fn handle_startup(app: AppHandle) {
    info!("Starting auto-start profiles check...");
    let manager = app.state::<AppSettingsManager>();

    let settings_map = RemoteSettings::load_all(manager.inner());

    let mut tasks: Vec<tokio::task::JoinHandle<()>> = Vec::new();

    for (remote_name, settings) in &settings_map {
        for &op_type in OperationType::ALL {
            if let Some(configs) = settings.get_configs(op_type) {
                let op = match op_type {
                    OperationType::Mount => Op::Mount,
                    OperationType::Serve => Op::Serve,
                    transfer => Op::Sync(transfer),
                };
                push_auto_start_tasks(&mut tasks, &app, remote_name, configs, op);
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

/// Which auto-start entry point to use for a profile.
#[derive(Clone, Copy)]
enum Op {
    Mount,
    Serve,
    /// Transfers go through `start_profile_batch` with the given operation type.
    Sync(OperationType),
}

/// Iterate a profile-config map, spawning a task for every profile with
/// `app.auto_start == true`.
fn push_auto_start_tasks(
    tasks: &mut Vec<tokio::task::JoinHandle<()>>,
    app: &AppHandle,
    remote_name: &str,
    configs: &HashMap<String, ProfileConfig>,
    op: Op,
) {
    for (pname, cfg) in configs {
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
        scoped_targets: None,
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
        scoped_targets: None,
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

async fn auto_start_sync(
    app: &AppHandle,
    remote_name: &str,
    profile_name: &str,
    transfer_type: OperationType,
) {
    let params = ProfileParams {
        remote_name: remote_name.to_string(),
        profile_name: profile_name.to_string(),
        source: Some(Origin::Startup),
        no_cache: Some(false),
        scoped_targets: None,
    };

    let result = start_profile_batch(app.clone(), transfer_type, params).await;

    match result {
        Ok(_) => {
            info!("Auto-started {transfer_type}: {remote_name} profile '{profile_name}'");
        }
        Err(e) => {
            warn!(
                "Failed to auto-start {transfer_type} {remote_name} profile '{profile_name}': {e}"
            );
        }
    }
}
