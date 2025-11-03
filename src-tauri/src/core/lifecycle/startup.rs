use log::{debug, error, info};
use tauri::AppHandle;

use crate::core::config_extractor::{
    BisyncConfig, CopyConfig, IsValid, MountConfig, MoveConfig, SyncConfig,
};
use crate::core::scheduler::commands::SCHEDULER;
use crate::core::spawn_helpers::{spawn_bisync, spawn_copy, spawn_mount, spawn_move, spawn_sync};
// spawn_helpers now construct rclone param structs; no direct command param imports needed here
use crate::rclone::state::{
    CACHE, get_cached_remotes, scheduled_tasks::SCHEDULED_TASKS_CACHE, start_mounted_remote_watcher,
};

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

    // Initialize and start the cron scheduler
    info!("⏰ Initializing cron scheduler...");
    if let Err(e) = initialize_scheduler(app_handle.clone()).await {
        error!("❌ Failed to initialize cron scheduler: {}", e);
    } else {
        info!("✅ Cron scheduler initialized and started successfully");
    }

    // Start the mounted remote watcher for continuous monitoring
    info!("📡 Starting mounted remote watcher...");
    tokio::spawn(start_mounted_remote_watcher(app_handle.clone()));
}

/// Initialize the cron scheduler with tasks loaded from remote configs
async fn initialize_scheduler(app_handle: AppHandle) -> Result<(), String> {
    // Get all remote settings from cache
    let settings = CACHE.settings.read().await;
    let all_settings = serde_json::json!(settings.clone());

    // Load scheduled tasks from remote configs
    info!("📋 Loading scheduled tasks from remote configs...");
    let task_count = SCHEDULED_TASKS_CACHE
        .load_from_remote_configs(&all_settings)
        .await?;

    info!("📅 Loaded {} scheduled task(s)", task_count);

    // Initialize the scheduler with the app handle
    let mut scheduler = SCHEDULER.write().await;
    scheduler.initialize(app_handle.clone()).await?;

    // Start the scheduler
    scheduler.start().await?;

    // Reload all tasks (this will schedule them)
    scheduler.reload_tasks().await?;

    Ok(())
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
}
