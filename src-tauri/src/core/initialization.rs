use log::{debug, error, info};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use crate::{
    core::{event_listener::setup_event_listener, scheduler::engine::CronScheduler},
    rclone::{
        commands::system::set_bandwidth_limit,
        queries::flags::set_rclone_option,
        state::{
            engine::ENGINE_STATE,
            scheduled_tasks::ScheduledTasksCache,
            watcher::{start_mounted_remote_watcher, start_serve_watcher},
        },
    },
    utils::{
        app::builder::setup_tray,
        types::{
            all_types::{RcApiEngine, RcloneState, RemoteCache},
            settings::AppSettings,
        },
    },
};

/// Initializes Rclone API and OAuth state, and launches the Rclone engine.
pub fn init_rclone_state(
    app_handle: &tauri::AppHandle,
    settings: &AppSettings,
) -> Result<(), String> {
    let api_url = format!("http://127.0.0.1:{}", settings.core.rclone_api_port);
    let oauth_url = format!("http://127.0.0.1:{}", settings.core.rclone_oauth_port);

    ENGINE_STATE
        .set_api(api_url, settings.core.rclone_api_port)
        .map_err(|e| format!("Failed to set Rclone API: {e}"))?;

    ENGINE_STATE
        .set_oauth(oauth_url, settings.core.rclone_oauth_port)
        .map_err(|e| format!("Failed to set Rclone OAuth: {e}"))?;

    let mut engine = RcApiEngine::lock_engine()?;
    engine.init(app_handle);

    info!("🔄 Rclone engine initialized");
    Ok(())
}

/// Sets up the configuration directory for the application
pub fn setup_config_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let config_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;

    std::fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed to create config directory: {e}"))?;

    Ok(config_dir)
}

/// Handles async startup tasks
pub async fn initialization(app_handle: tauri::AppHandle, settings: AppSettings) {
    debug!("🚀 Starting async startup tasks");

    setup_event_listener(&app_handle);

    // Step 1: Refresh caches FIRST (need data for scheduler)
    info!("📊 Refreshing caches...");
    let cache = app_handle.state::<RemoteCache>();

    match cache.refresh_all(app_handle.clone()).await {
        Ok(_) => {
            info!("✅ Caches refreshed successfully");
        }
        Err(e) => {
            error!("❌ Failed to refresh caches: {e}");
        }
    }

    // Step 2: Initialize and start scheduler with loaded config
    info!("⏰ Initializing cron scheduler...");
    match initialize_scheduler(app_handle.clone()).await {
        Ok(_) => {
            info!("✅ Cron scheduler initialized and started successfully");
        }
        Err(e) => {
            error!("❌ Failed to initialize cron scheduler: {}", e);
        }
    }

    // Step 3: Start watchers
    info!("📡 Starting mounted remote watcher...");
    tokio::spawn(start_mounted_remote_watcher(app_handle.clone()));

    info!("📡 Starting serve watcher...");
    start_serve_watcher(app_handle.clone());

    // Step 4: Setup tray if needed
    let force_tray = std::env::args().any(|arg| arg == "--tray");
    if settings.general.tray_enabled || force_tray {
        if force_tray {
            debug!("🧊 Setting up tray (forced by --tray argument)");
        } else {
            debug!("🧊 Setting up tray (enabled in settings)");
        }
        if let Err(e) = setup_tray(app_handle.clone(), settings.core.max_tray_items).await {
            error!("Failed to setup tray: {e}");
        }
    }

    info!("🎉 Initialization complete");
}

/// Initialize the cron scheduler with tasks loaded from remote configs
async fn initialize_scheduler(app_handle: AppHandle) -> Result<(), String> {
    let cache_state = app_handle.state::<ScheduledTasksCache>();
    let scheduler_state = app_handle.state::<CronScheduler>();
    let remote_cache = app_handle.state::<RemoteCache>();

    let settings = remote_cache.get_settings().await;
    let all_settings = serde_json::json!(settings.clone());

    info!("📋 Loading scheduled tasks from remote configs...");
    let task_count = cache_state
        .load_from_remote_configs(&all_settings, scheduler_state.clone())
        .await?;

    info!("📅 Loaded {} scheduled task(s)", task_count);

    scheduler_state.initialize(app_handle.clone()).await?;
    scheduler_state.start().await?;
    scheduler_state.reload_tasks(cache_state).await?;

    Ok(())
}

pub async fn apply_core_settings(app_handle: &tauri::AppHandle, settings: &AppSettings) {
    if !settings.core.bandwidth_limit.is_empty() {
        debug!(
            "🌐 Setting bandwidth limit: {}",
            settings.core.bandwidth_limit
        );
        let rclone_state = app_handle.state::<RcloneState>();

        if let Err(e) = set_bandwidth_limit(
            app_handle.clone(),
            Some(settings.core.bandwidth_limit.clone()),
            rclone_state,
        )
        .await
        {
            error!("Failed to set bandwidth limit: {e}");
        }
    }

    // Apply RClone backend settings from backend.json
    if let Err(e) = apply_backend_settings(app_handle).await {
        error!("Failed to apply backend settings: {e}");
    }
}

/// Apply RClone backend settings from backend.json file
pub async fn apply_backend_settings(app_handle: &tauri::AppHandle) -> Result<(), String> {
    use crate::core::settings::rclone_backend::load_rclone_backend_options;

    debug!("🔧 Applying RClone backend settings from backend.json");

    let backend_options = load_rclone_backend_options(app_handle.clone())
        .await
        .map_err(|e| format!("Failed to load backend options: {}", e))?;

    let rclone_state = app_handle.state::<RcloneState>();

    if let Some(backend_obj) = backend_options.as_object() {
        for (block_name, block_options) in backend_obj {
            if let Some(options_obj) = block_options.as_object() {
                for (option_name, option_value) in options_obj {
                    debug!(
                        "🔧 Setting RClone option: {}.{} = {:?}",
                        block_name, option_name, option_value
                    );

                    if let Err(e) = set_rclone_option(
                        rclone_state.clone(),
                        block_name.clone(),
                        option_name.clone(),
                        option_value.clone(),
                    )
                    .await
                    {
                        error!(
                            "Failed to set RClone option {}.{}: {}",
                            block_name, option_name, e
                        );
                    }
                }
            }
        }
    }

    info!("✅ RClone backend settings applied successfully");
    Ok(())
}
