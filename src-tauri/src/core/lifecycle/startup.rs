use log::{debug, error, info};
use tauri::AppHandle;

use crate::core::config_extractor::ServeConfig;
use crate::core::config_extractor::{
    BisyncConfig, CopyConfig, IsValid, MountConfig, MoveConfig, SyncConfig,
};
use crate::core::spawn_helpers::spawn_serve;
use crate::core::spawn_helpers::{spawn_bisync, spawn_copy, spawn_mount, spawn_move, spawn_sync};
use crate::rclone::state::cache::{CACHE, get_cached_remotes};
// spawn_helpers now construct rclone param structs; no direct command param imports needed here

/// Helper function to handle auto-start logic for a given operation.
async fn handle_auto_start<C, T, E, F, Fut>(
    remote_name: &str,
    settings: &serde_json::Value,
    config_name: &str,
    app_handle: AppHandle,
    extractor: E,
    spawn_fn: F,
) where
    E: Fn(&serde_json::Value) -> C + Send + Sync + 'static,
    C: IsValid + Clone + Send + Sync + 'static,
    F: Fn(String, C, AppHandle) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = Result<T, String>> + Send,
{
    let should_auto = settings
        .get(config_name)
        .and_then(|v| v.get("autoStart"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let operation_name = config_name.trim_end_matches("Config");

    if should_auto {
        let cfg = extractor(settings);
        if cfg.is_valid() {
            if let Err(e) = spawn_fn(remote_name.to_string(), cfg.clone(), app_handle).await {
                error!(
                    "Failed to auto-start {} for {}: {}",
                    operation_name, remote_name, e
                );
            } else {
                debug!("{} task spawned for {}", operation_name, remote_name);
            }
        } else {
            error!(
                "❌ {} configuration incomplete for {}",
                operation_name, remote_name
            );
        }
    } else {
        debug!(
            "Skipping {} for {}: autoStart is not enabled",
            operation_name, remote_name
        );
    }
}

/// Main entry point for handling startup tasks.
pub async fn handle_startup(app_handle: AppHandle) {
    info!("🚀 Checking startup options...");

    // Initialize remotes
    let remotes_result = initialize_remotes().await;

    // Process remotes after retrieval
    if let Ok(remotes) = remotes_result {
        for remote in remotes.iter() {
            handle_remote_startup(remote.to_string(), app_handle.clone()).await;
        }
    }
}

/// Fetches the list of available remotes.
async fn initialize_remotes() -> Result<Vec<String>, String> {
    let remotes = get_cached_remotes().await?;
    Ok(remotes)
}

/// Handles startup logic for an individual remote.
async fn handle_remote_startup(remote_name: String, app_handle: AppHandle) {
    // Get settings from cache (consistent with actions.rs)
    let settings = match CACHE.settings.read().await.get(&remote_name).cloned() {
        Some(s) => s,
        None => {
            error!("Remote {remote_name} not found in cached settings");
            return;
        }
    };

    // Handle auto-start for each operation, using extractor functions and spawn helpers
    handle_auto_start(
        &remote_name,
        &settings,
        "mountConfig",
        app_handle.clone(),
        MountConfig::from_settings,
        |r, c, a| spawn_mount(r, c, None, a),
    )
    .await;
    handle_auto_start(
        &remote_name,
        &settings,
        "syncConfig",
        app_handle.clone(),
        SyncConfig::from_settings,
        spawn_sync,
    )
    .await;
    handle_auto_start(
        &remote_name,
        &settings,
        "copyConfig",
        app_handle.clone(),
        CopyConfig::from_settings,
        spawn_copy,
    )
    .await;
    handle_auto_start(
        &remote_name,
        &settings,
        "moveConfig",
        app_handle.clone(),
        MoveConfig::from_settings,
        spawn_move,
    )
    .await;
    handle_auto_start(
        &remote_name,
        &settings,
        "bisyncConfig",
        app_handle.clone(),
        BisyncConfig::from_settings,
        spawn_bisync,
    )
    .await;

    // Handle serve auto-start as well
    handle_auto_start(
        &remote_name,
        &settings,
        "serveConfig",
        app_handle.clone(),
        ServeConfig::from_settings,
        spawn_serve,
    )
    .await;
}
