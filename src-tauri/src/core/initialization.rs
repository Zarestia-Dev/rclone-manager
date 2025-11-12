use log::{debug, error, info};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use crate::{
    core::{event_listener::setup_event_listener, scheduler::commands::SCHEDULER},
    rclone::{
        commands::system::set_bandwidth_limit,
        queries::flags::set_rclone_option,
        state::{
            cache::CACHE,
            engine::ENGINE_STATE,
            scheduled_tasks::SCHEDULED_TASKS_CACHE,
            watcher::{start_mounted_remote_watcher, start_serve_watcher},
        },
    },
    utils::{
        app::builder::setup_tray,
        types::{
            all_types::{RcApiEngine, RcloneState},
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
// In initialization.rs - improved initialization
pub async fn initialization(app_handle: tauri::AppHandle, settings: AppSettings) {
    debug!("🚀 Starting async startup tasks");

    setup_event_listener(&app_handle);

    // Step 1: Refresh caches FIRST (need data for scheduler)
    info!("📊 Refreshing caches...");
    match CACHE.refresh_all(app_handle.clone()).await {
        Ok(_) => {
            info!("✅ Caches refreshed successfully");
        }
        Err(e) => {
            error!("❌ Failed to refresh caches: {e}");
            // Consider if this should be fatal
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
            // Scheduler failure might not be fatal for the app
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

    // if !settings.core.rclone_config_file.is_empty() {
    //     debug!(
    //         "🔗 Setting Rclone config path: {}",
    //         settings.core.rclone_config_file
    //     );
    //     if let Err(e) =
    //         set_rclone_config_file(app_handle.clone(), settings.core.rclone_config_file.clone())
    //             .await
    //     {
    //         error!("Failed to set Rclone config path: {e}");
    //     }
    // }
}

/// Apply RClone backend settings from backend.json file
pub async fn apply_backend_settings(app_handle: &tauri::AppHandle) -> Result<(), String> {
    use crate::core::settings::rclone_backend::load_rclone_backend_options;

    debug!("🔧 Applying RClone backend settings from backend.json");

    // Load backend options from store
    let backend_options = load_rclone_backend_options(app_handle.clone())
        .await
        .map_err(|e| format!("Failed to load backend options: {}", e))?;

    let rclone_state = app_handle.state::<RcloneState>();

    // Apply each block's options
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
                        // Continue with other options even if one fails
                    }
                }
            }
        }
    }

    info!("✅ RClone backend settings applied successfully");
    Ok(())
}
