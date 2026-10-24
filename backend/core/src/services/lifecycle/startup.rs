//! Startup routines for auto-starting profiles (mount, serve, sync, etc.)
//!
//! This module provides the `handle_startup` function that runs on app startup
//! to automatically start any profiles that are configured with autoStart: true

use crate::context::AppHandle;
use crate::services::settings::AppSettingsManager;
use crate::{
    rclone::commands::{
        mount::mount_remote_profile, serve::start_serve_profile, sync::start_profile_batch,
    },
    utils::{
        types::origin::Origin,
        types::remotes::{OperationType, ProfileConfig, ProfileParams},
    },
};
use log::{info, warn};
use std::collections::HashMap;

/// Auto-start all profiles that have autoStart: true
/// This is called during app initialization.
/// Profiles are started in parallel for faster startup.
pub async fn handle_startup(app: AppHandle) {
    info!("Starting auto-start profiles check...");
    let manager = app.state::<AppSettingsManager>();

    let (backend, settings_map) = app
        .state::<crate::rclone::backend::BackendManager>()
        .active_remote_configs(manager.inner())
        .await;

    let mut tasks: Vec<tokio::task::JoinHandle<()>> = Vec::new();

    for (remote_name, settings) in &settings_map {
        for &op_type in OperationType::ALL {
            if let Some(configs) = settings.get_configs(op_type) {
                push_auto_start_tasks(
                    &mut tasks,
                    &app,
                    &backend.name,
                    remote_name,
                    configs,
                    op_type,
                );
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

/// Spawn each enabled profile with the backend from the startup snapshot.
fn push_auto_start_tasks(
    tasks: &mut Vec<tokio::task::JoinHandle<()>>,
    app: &AppHandle,
    backend_name: &str,
    remote_name: &str,
    configs: &HashMap<String, ProfileConfig>,
    operation: OperationType,
) {
    for (profile_name, config) in configs {
        if !config.app.auto_start {
            continue;
        }
        let params = ProfileParams {
            remote_name: remote_name.to_string(),
            profile_name: profile_name.clone(),
            backend_name: Some(backend_name.to_string()),
            source: Some(Origin::Startup),
            no_cache: Some(false),
            scoped_targets: None,
            execute_id: None,
        };
        let app = app.clone();
        tasks.push(crate::utils::spawn(async move {
            if app
                .state::<crate::utils::types::state::RcloneState>()
                .is_shutting_down()
            {
                return;
            }
            let remote = params.remote_name.clone();
            let profile = params.profile_name.clone();
            let result = match operation {
                OperationType::Mount => mount_remote_profile(app, params).await,
                OperationType::Serve => start_serve_profile(app, params).await.map(|_| ()),
                transfer => start_profile_batch(app, transfer, params).await.map(|_| ()),
            };
            match result {
                Ok(()) => info!("Auto-started {operation}: {remote} profile '{profile}'"),
                Err(error) => {
                    warn!("Failed to auto-start {operation} {remote} profile '{profile}': {error}")
                }
            }
        }));
    }
}
