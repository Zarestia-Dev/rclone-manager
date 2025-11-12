use log::{debug, error, info};
use serde_json::Value;
use tauri::AppHandle;

use crate::rclone::{
    commands::{
        mount::{MountParams, mount_remote},
        serve::{ServeParams, start_serve},
        sync::{
            BisyncParams, CopyParams, MoveParams, SyncParams, start_bisync, start_copy, start_move,
            start_sync,
        },
    },
    state::cache::{CACHE, get_cached_remotes},
};

/// Generic handler for auto-start operations
use std::future::Future;
use std::pin::Pin;

async fn handle_auto_start<P, F, T>(
    remote_name: &str,
    settings: &Value,
    operation_name: &str,
    app_handle: AppHandle,
    from_settings: fn(String, &Value) -> Option<P>,
    should_start: fn(&Value) -> bool,
    spawn_fn: F,
) where
    F: Fn(AppHandle, P) -> Pin<Box<dyn Future<Output = Result<T, String>> + Send>>
        + Send
        + Sync
        + 'static,
    P: Send + 'static,
    T: Send + 'static,
{
    if !should_start(settings) {
        debug!(
            "Skipping {} for {}: autoStart is not enabled",
            operation_name, remote_name
        );
        return;
    }

    match from_settings(remote_name.to_string(), settings) {
        Some(params) => {
            if let Err(e) = spawn_fn(app_handle.clone(), params).await {
                error!(
                    "Failed to auto-start {} for {}: {}",
                    operation_name, remote_name, e
                );
            } else {
                debug!("{} task spawned for {}", operation_name, remote_name);
            }
        }
        None => {
            error!(
                "❌ {} configuration incomplete for {}",
                operation_name, remote_name
            );
        }
    }
}

/// Main entry point for handling startup tasks.
pub async fn handle_startup(app_handle: AppHandle) {
    info!("🚀 Checking startup options...");

    // Initialize remotes
    let remotes = match get_cached_remotes().await {
        Ok(r) => r,
        Err(e) => {
            error!("Failed to get remotes: {}", e);
            return;
        }
    };

    for remote in remotes {
        handle_remote_startup(&remote, app_handle.clone()).await;
    }
}

/// Handles startup logic for an individual remote.
async fn handle_remote_startup(remote_name: &str, app_handle: AppHandle) {
    let settings = match CACHE.settings.read().await.get(remote_name).cloned() {
        Some(s) => s,
        None => {
            error!("Remote {} not found in cached settings", remote_name);
            return;
        }
    };

    // Handle each operation type
    handle_auto_start(
        remote_name,
        &settings,
        "mount",
        app_handle.clone(),
        MountParams::from_settings,
        MountParams::should_auto_start,
        |app, params| Box::pin(mount_remote(app, params)),
    )
    .await;

    handle_auto_start(
        remote_name,
        &settings,
        "sync",
        app_handle.clone(),
        SyncParams::from_settings,
        SyncParams::should_auto_start,
        |app, params| Box::pin(start_sync(app, params)),
    )
    .await;

    handle_auto_start(
        remote_name,
        &settings,
        "copy",
        app_handle.clone(),
        CopyParams::from_settings,
        CopyParams::should_auto_start,
        |app, params| Box::pin(start_copy(app, params)),
    )
    .await;

    handle_auto_start(
        remote_name,
        &settings,
        "move",
        app_handle.clone(),
        MoveParams::from_settings,
        MoveParams::should_auto_start,
        |app, params| Box::pin(start_move(app, params)),
    )
    .await;

    handle_auto_start(
        remote_name,
        &settings,
        "bisync",
        app_handle.clone(),
        BisyncParams::from_settings,
        BisyncParams::should_auto_start,
        |app, params| Box::pin(start_bisync(app, params)),
    )
    .await;

    handle_auto_start(
        remote_name,
        &settings,
        "serve",
        app_handle.clone(),
        ServeParams::from_settings,
        ServeParams::should_auto_start,
        |app, params| Box::pin(start_serve(app, params)),
    )
    .await;
}
